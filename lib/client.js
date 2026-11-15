/**
 * dsh-observer 的浏览器半侧。
 *
 * 产物格式必须是 `window.__ModuleLoader__.load({ id, factory(require) })`，
 * `id` 必须等于包名（宿主按包名挂载模块）。React 由浏览器模块表提供，
 * 不随插件打包，所以直接 `require('react')`。
 *
 * 这里只做一件事：往 `shell.overlay` 挂一个悬浮窗。
 *   - 收起态：左下角一枚小胶囊，显示状态点 + 最新播报摘要
 *   - 展开态：卡片，显示最新播报、token 用量、追问输入框、设置面板
 *   - 可拖动（桌面端），位置存 localStorage；窄屏自动变成底部抽屉
 *
 * 为什么不用 `conversation.chat.node`：宿主的 step 投影会把同一 turn:step
 * 的消息归并成一个节点，插进对话流的旁白会被覆盖掉。`shell.overlay`
 * 不参与会话投影，是唯一「一定看得见」的通道。
 */
window.__ModuleLoader__.load({
  id: 'dsh-observer',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/observer'
    const POLL_MS = 2000
    const POS_KEY = 'dsh-observer:pos'
    const STYLE_ID = 'dsh-observer-style'
    const MOBILE_BREAKPOINT = 640
    const CARD_W = 380
    const CARD_H = 120

    // -----------------------------------------------------------------------
    // 小工具
    // -----------------------------------------------------------------------

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function formatTime(ts) {
      if (typeof ts !== 'number' || ts <= 0) return ''
      const date = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function formatTokens(n) {
      const value = Number(n) || 0
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
      return String(value)
    }

    /** 粗略估算：中英混排约 2.5 字符/token，外加系统提示与输出。 */
    function estimatePerHour(cfg, intervalSeconds) {
      const inputChars =
        (Number(cfg?.maxTranscriptChars) || 6000) +
        (cfg?.thinking === false ? 0 : Number(cfg?.maxReasoningChars) || 2000)
      const perCall = Math.round(inputChars / 2.5) + 320 + 220
      return Math.round((perCall * 3600) / Math.max(1, intervalSeconds))
    }

    function loadPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && Number.isFinite(parsed.left) && Number.isFinite(parsed.bottom)) {
          return {
            left: clamp(parsed.left, 8, Math.max(8, window.innerWidth - CARD_W - 8)),
            bottom: clamp(parsed.bottom, 8, Math.max(8, window.innerHeight - CARD_H - 8)),
          }
        }
      } catch {
        // 坏数据直接忽略
      }
      return null
    }

    function savePos(pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch {
        // 隐私模式等场景写不进去，忽略
      }
    }

    function currentSessionId() {
      try {
        const node = document.querySelector('[data-conversation-session]')
        const id = node?.getAttribute('data-conversation-session')
        return typeof id === 'string' && id !== '' ? id : null
      } catch {
        return null
      }
    }

    /** 默认贴住输入框左边界、输入框上沿（对话区左下角）。 */
    function defaultSeat() {
      let left = 24
      let bottom = 96
      try {
        const input =
          document.querySelector('[data-composer-input]') ??
          document.querySelector('[data-composer-seat] [contenteditable="true"]') ??
          document.querySelector('[contenteditable="true"]')
        if (input !== null) {
          const box = input.getBoundingClientRect()
          if (box.width > 0) {
            left = Math.max(12, box.left)
            bottom = Math.max(12, window.innerHeight - box.top + 12)
          }
        }
      } catch {
        // 用兜底值
      }
      return { left, bottom }
    }

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.dataset.plugin = 'dsh-observer'
      el.textContent = [
        '@keyframes dsh-observer-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
        '@keyframes dsh-observer-spin{to{transform:rotate(360deg)}}',
        '.dsh-observer-scroll::-webkit-scrollbar{width:6px}',
        '.dsh-observer-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,rgba(0,0,0,.18));border-radius:3px}',
        '.dsh-observer-scroll::-webkit-scrollbar-track{background:transparent}',
        '.dsh-observer-btn{transition:background .15s ease,opacity .15s ease;background:transparent}',
        '.dsh-observer-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
        '.dsh-observer-btn:focus-visible,.dsh-observer-pill:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
        '.dsh-observer-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
        '.dsh-observer-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-1px}',
        '.dsh-observer-input::placeholder{color:var(--dsw-alias-label-secondary)}',
        '.dsh-observer-pill{transition:box-shadow .18s ease;box-shadow:0 6px 20px rgba(0,0,0,.14);box-sizing:border-box}',
        '.dsh-observer-pill:hover{box-shadow:0 10px 30px rgba(0,0,0,.22)}',
        '.dsh-observer-scroll{mask-image:linear-gradient(to bottom,#000 calc(100% - 24px),transparent);scrollbar-width:thin}',
        '@keyframes dsh-observer-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
        '.dsh-observer-card{animation:dsh-observer-in .18s ease}',
      ].join('\n')
      document.head.appendChild(el)
    }

    // -----------------------------------------------------------------------
    // 极简 markdown 渲染（够用即可，不引第三方库）
    // -----------------------------------------------------------------------

    function inline(text) {
      const parts = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
      let last = 0
      let match
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          parts.push(h('strong', { key: `b${parts.length}`, style: { fontWeight: 600 } }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          parts.push(
            h(
              'code',
              {
                key: `c${parts.length}`,
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '0.92em',
                  padding: '1px 4px',
                  borderRadius: 4,
                  background: 'var(--dsw-alias-markdown-inline-code, rgba(127,127,127,.14))',
                },
              },
              token.slice(1, -1),
            ),
          )
        } else {
          parts.push(h('em', { key: `i${parts.length}` }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < text.length) parts.push(text.slice(last))
      return parts
    }

    function renderMarkdown(text) {
      if (typeof text !== 'string' || text === '') return null
      const out = []
      let bullets = []
      const flush = () => {
        if (bullets.length > 0) {
          out.push(h('ul', { key: `u${out.length}`, style: { margin: '4px 0', paddingLeft: 18 } }, bullets))
          bullets = []
        }
      }
      for (const raw of text.split('\n')) {
        const line = raw.trimEnd()
        if (line === '') {
          flush()
          continue
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/)
        const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
        if (bullet !== null || numbered !== null) {
          bullets.push(
            h('li', { key: `li${out.length}-${bullets.length}`, style: { margin: '1px 0' } }, inline(bullet !== null ? bullet[1] : numbered[1])),
          )
          continue
        }
        flush()
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        if (heading !== null) {
          out.push(
            h('div', { key: `h${out.length}`, style: { fontWeight: 600, margin: '6px 0 2px' } }, inline(heading[2])),
          )
          continue
        }
        out.push(h('div', { key: `p${out.length}`, style: { margin: '2px 0' } }, inline(line)))
      }
      flush()
      return out
    }

    // -----------------------------------------------------------------------
    // 设置面板
    // -----------------------------------------------------------------------

    function Row({ label, children, hint }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 } },
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, label),
        children,
        hint !== undefined
          ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, hint)
          : null,
      )
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12.5,
      fontFamily: 'inherit',
    }

    const selectStyle = { ...inputStyle, cursor: 'pointer' }

    const headerBtnStyle = {
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 13,
      padding: '3px 6px',
      borderRadius: 6,
      minWidth: 32,
      minHeight: 32,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'inherit',
    }

    function Segmented({ value, options, onChange }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 2,
            padding: 2,
            borderRadius: 9,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l2)',
          },
        },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              onClick: () => onChange(option.value),
              style: {
                flex: 1,
                padding: '5px 8px',
                borderRadius: 7,
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'inherit',
                background: value === option.value ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                color: value === option.value ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                boxShadow: value === option.value ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
              },
            },
            option.label,
          ),
        ),
      )
    }

    function Toggle({ checked, onChange, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label ?? '开关',
          onClick: () => onChange(!checked),
          style: {
            width: 38,
            height: 22,
            borderRadius: 11,
            border: 'none',
            cursor: 'pointer',
            padding: 2,
            background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: checked ? 'flex-end' : 'flex-start',
            transition: 'background .15s ease',
          },
        },
        h('span', {
          style: {
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: checked ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-switch-thumb, #fff)',
            boxShadow: '0 1px 2px rgba(0,0,0,.2)',
          },
        }),
      )
    }

    function SettingsPanel({ config, onSaved, onClose }) {
      const [draft, setDraft] = React.useState(() => ({ ...config }))
      const [providers, setProviders] = React.useState([])
      const [efforts, setEfforts] = React.useState([])
      const [apiKey, setApiKey] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        let alive = true
        fetch(`${API}/models`, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => {
            if (alive && body?.ok && Array.isArray(body.providers)) setProviders(body.providers)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      React.useEffect(() => {
        if (draft.modelMode !== 'provider' || draft.provider === '' || draft.model === '') {
          setEfforts([])
          return undefined
        }
        let alive = true
        const query = `provider=${encodeURIComponent(draft.provider)}&model=${encodeURIComponent(draft.model)}`
        fetch(`${API}/model?${query}`, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => {
            if (!alive) return
            const list = body?.ok ? body.model?.reasoning?.efforts : null
            setEfforts(Array.isArray(list) ? list : [])
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [draft.modelMode, draft.provider, draft.model])

      const set = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }))

      // 与已保存配置比对：只有点「保存」才会真正生效
      const dirty = React.useMemo(() => {
        const keys = [
          'enabled',
          'overlayEnabled',
          'mobileOverlayEnabled',
          'intervalSeconds',
          'thinking',
          'modelMode',
          'provider',
          'model',
          'reasoningEffort',
          'customBaseUrl',
          'customModel',
        ]
        return keys.some((key) => String(draft[key] ?? '') !== String(config[key] ?? ''))
      }, [draft, config])

      const currentProvider = providers.find((provider) => provider.id === draft.provider) ?? null
      const models = currentProvider?.models ?? []

      const save = async () => {
        setSaving(true)
        setMessage('')
        try {
          const body = { config: draft }
          if (apiKey.trim() !== '') body.apiKey = apiKey.trim()
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const json = await res.json()
          if (json?.ok) {
            setMessage(json.warning === 'secret-save-failed' ? '已保存，但密钥写入失败' : '已保存')
            setApiKey('')
            onSaved?.(json.config)
          } else {
            setMessage('保存失败')
          }
        } catch {
          setMessage('保存失败')
        } finally {
          setSaving(false)
        }
      }

      const clearKey = async () => {
        setSaving(true)
        setMessage('')
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: draft, clearApiKey: true }),
          })
          const json = await res.json()
          if (json?.ok) {
            setMessage('已清除密钥')
            onSaved?.(json.config)
          } else {
            setMessage('清除失败')
          }
        } catch {
          setMessage('清除失败')
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h(
          'div',
          { className: 'dsh-observer-scroll', style: { flex: 1, overflowY: 'auto', padding: '12px 12px 4px' } },
          h(
            Row,
            { label: '模型来源' },
            h(Segmented, {
              value: draft.modelMode,
              options: [
                { value: 'provider', label: '已有提供商' },
                { value: 'custom', label: '自定义端点' },
              ],
              onChange: (value) => set('modelMode', value),
            }),
          ),
          draft.modelMode === 'provider'
            ? [
                h(
                  Row,
                  { key: 'provider', label: '提供商' },
                  h(
                    'select',
                    {
                      className: 'dsh-observer-input',
                      style: selectStyle,
                      value: draft.provider,
                      onChange: (event) => {
                        const provider = event.target.value
                        const first = providers.find((item) => item.id === provider)?.models?.[0]?.id ?? ''
                        setDraft((prev) => ({ ...prev, provider, model: first, reasoningEffort: '' }))
                      },
                    },
                    h('option', { value: '' }, '请选择…'),
                    providers.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.name || provider.id)),
                  ),
                ),
                h(
                  Row,
                  { key: 'model', label: '模型' },
                  h(
                    'select',
                    {
                      className: 'dsh-observer-input',
                      style: selectStyle,
                      value: draft.model,
                      onChange: (event) =>
                        setDraft((prev) => ({ ...prev, model: event.target.value, reasoningEffort: '' })),
                    },
                    h('option', { value: '' }, '请选择…'),
                    models.map((model) => h('option', { key: model.id, value: model.id }, model.name || model.id)),
                  ),
                ),
                efforts.length > 0
                  ? h(
                      Row,
                      { key: 'effort', label: '思考强度' },
                      h(
                        'select',
                        {
                          className: 'dsh-observer-input',
                          style: selectStyle,
                          value: draft.reasoningEffort,
                          onChange: (event) => set('reasoningEffort', event.target.value),
                        },
                        h('option', { value: '' }, '默认'),
                        efforts.map((effort) =>
                          h('option', { key: effort.id, value: effort.id }, effort.name || effort.id),
                        ),
                      ),
                    )
                  : null,
              ]
            : [
                h(
                  Row,
                  { key: 'base', label: '接口地址', hint: 'OpenAI 兼容，填到 /v1 即可，自动补 /chat/completions' },
                  h('input', {
                    className: 'dsh-observer-input',
                    style: inputStyle,
                    value: draft.customBaseUrl,
                    placeholder: 'https://api.example.com/v1',
                    onChange: (event) => set('customBaseUrl', event.target.value),
                  }),
                ),
                h(
                  Row,
                  { key: 'cmodel', label: '模型 ID' },
                  h('input', {
                    className: 'dsh-observer-input',
                    style: inputStyle,
                    value: draft.customModel,
                    placeholder: 'gpt-4o-mini',
                    onChange: (event) => set('customModel', event.target.value),
                  }),
                ),
                h(
                  Row,
                  { key: 'key', label: 'API Key', hint: config.hasApiKey ? '已保存，留空则不修改' : '仅保存在本机' },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('input', {
                      className: 'dsh-observer-input',
                      style: { ...inputStyle, flex: 1, minWidth: 0 },
                      type: 'password',
                      value: apiKey,
                      placeholder: config.hasApiKey ? '••••••••' : 'sk-…',
                      onChange: (event) => setApiKey(event.target.value),
                    }),
                    config.hasApiKey
                      ? h(
                          'button',
                          {
                            type: 'button',
                            onClick: clearKey,
                            disabled: saving,
                            className: 'dsh-observer-btn',
                            style: {
                              flex: '0 0 auto',
                              padding: '6px 10px',
                              borderRadius: 7,
                              border: '1px solid var(--dsw-alias-border-l2)',
                              background: 'transparent',
                              color: 'var(--dsw-alias-label-secondary)',
                              fontSize: 12,
                              cursor: 'pointer',
                            },
                          },
                          '清除',
                        )
                      : null,
                  ),
                ),
              ],
          h(
            Row,
            { label: '播报频率' },
            h(
              'select',
              {
                className: 'dsh-observer-input',
                style: selectStyle,
                value: String(draft.intervalSeconds),
                onChange: (event) => set('intervalSeconds', Number(event.target.value)),
              },
              (config.intervalChoices ?? [0, 30, 60, 120, 180, 300, 600]).map((seconds) =>
                h(
                  'option',
                  { key: seconds, value: String(seconds) },
                  seconds === 0
                    ? '永不 · 不自动播报'
                    : `${seconds} 秒 · 约 ${formatTokens(estimatePerHour(draft, seconds))} token/时`,
                ),
              ),
            ),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                marginBottom: 12,
              },
            },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '读取主对话思考'),
              h(
                'div',
                { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                '开启后旁路模型能看到主模型最近的推理，判断「接下来」更准',
              ),
            ),
            h(Toggle, { checked: draft.thinking !== false, onChange: (value) => set('thinking', value), label: '读取主对话思考' }),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                marginBottom: 12,
              },
            },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '启用播报'),
              h(
                'div',
                { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                '关闭后不再自动调用旁路模型，悬浮窗仍可手动刷新',
              ),
            ),
            h(Toggle, { checked: draft.enabled !== false, onChange: (value) => set('enabled', value), label: '启用播报' }),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                marginBottom: 12,
              },
            },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '显示悬浮窗'),
              h(
                'div',
                { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                '关闭后桌面端不再显示左下角胶囊，仍可从顶部「观察」栏查看',
              ),
            ),
            h(Toggle, {
              checked: draft.overlayEnabled !== false,
              onChange: (value) => set('overlayEnabled', value),
              label: '显示悬浮窗',
            }),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                marginBottom: 12,
              },
            },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '移动端显示悬浮窗'),
              h(
                'div',
                { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                '默认关闭，避免小屏遮挡输入框；移动端仍可从顶部「观察」栏查看',
              ),
            ),
            h(Toggle, {
              checked: draft.mobileOverlayEnabled === true,
              onChange: (value) => set('mobileOverlayEnabled', value),
              label: '移动端显示悬浮窗',
            }),
          ),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderTop: '1px solid var(--dsw-alias-border-l2)',
            },
          },
          h(
            'button',
            {
              type: 'button',
              onClick: save,
              disabled: saving,
              style: {
                flex: 1,
                padding: '7px 10px',
                borderRadius: 8,
                border: 'none',
                cursor: saving ? 'default' : 'pointer',
                background: 'var(--dsw-alias-brand-primary)',
                color: 'var(--dsw-alias-label-primary-inverted, #fff)',
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: 'inherit',
                opacity: saving ? 0.6 : 1,
              },
            },
            saving ? '保存中…' : '保存',
          ),
          message !== ''
            ? h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, message)
            : dirty
              ? h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-warn-primary)' } }, '未保存')
              : null,
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 悬浮窗
    // -----------------------------------------------------------------------

    function StatusDot({ state }) {
      let color = 'var(--dsw-alias-label-secondary)'
      let pulse = false
      if (state?.error) color = 'var(--dsw-alias-state-error-primary)'
      else if (state?.busy) {
        color = 'var(--dsw-alias-state-warn-primary)'
        pulse = true
      } else if (state?.running) color = 'var(--dsw-alias-state-success-primary)'
      return h('span', {
        style: {
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          flex: '0 0 auto',
          animation: pulse ? 'dsh-observer-pulse 1.2s ease-in-out infinite' : 'none',
        },
      })
    }

    function statusText(state) {
      if (state === null) return '连接中'
      if (state.error) return '出错'
      if (state.busy) return '播报中'
      if (state.running) return '观察中'
      return '空闲'
    }

    // -----------------------------------------------------------------------
    // 共享状态轮询
    // -----------------------------------------------------------------------

    function useObserverState(sessionIdOverride) {
      const [state, setState] = React.useState(null)
      const [sessionId, setSessionId] = React.useState(sessionIdOverride ?? null)

      React.useEffect(() => {
        let alive = true
        let inflight = false
        const tick = async () => {
          if (inflight) return
          inflight = true
          const sid = sessionIdOverride ?? currentSessionId()
          setSessionId((prev) => (prev === sid ? prev : sid))
          try {
            const query = sid === null ? '' : `?session=${encodeURIComponent(sid)}`
            const res = await fetch(`${API}/state${query}`, { headers: { accept: 'application/json' } })
            if (!res.ok) return
            const body = await res.json()
            if (alive && body?.ok) setState(body)
          } catch {
            // 网络抖动忽略，下一轮再试
          } finally {
            inflight = false
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionIdOverride])

      return { state, setState, sessionId }
    }

    // -----------------------------------------------------------------------
    // 面板（悬浮窗与顶部「观察」栏共用）
    // -----------------------------------------------------------------------

    function ObserverPanel({ state, setState, sessionId, variant, onCollapse, dragProps }) {
      const [showSettings, setShowSettings] = React.useState(false)
      const [question, setQuestion] = React.useState('')
      const [answer, setAnswer] = React.useState(null)
      const [asking, setAsking] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const [refreshError, setRefreshError] = React.useState('')

      const refreshNow = async () => {
        setRefreshing(true)
        setRefreshError('')
        try {
          const res = await fetch(`${API}/now`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId }),
          })
          const body = await res.json()
          if (body?.ok && body.narration) {
            setState((prev) => (prev === null ? prev : { ...prev, narration: body.narration }))
          } else {
            setRefreshError(body?.error === 'busy' ? '正在播报中，请稍候' : (body?.error ?? '播报失败'))
          }
        } catch {
          setRefreshError('网络错误，请重试')
        } finally {
          setRefreshing(false)
        }
      }

      const ask = async () => {
        const text = question.trim()
        if (text === '' || asking) return
        setAsking(true)
        setAnswer(null)
        try {
          const res = await fetch(`${API}/ask`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, question: text }),
          })
          const body = await res.json()
          setAnswer(body?.ok ? { text: body.answer } : { error: body?.error ?? '提问失败' })
          if (body?.ok) setQuestion('')
        } catch {
          setAnswer({ error: '提问失败' })
        } finally {
          setAsking(false)
        }
      }

      const narration = state?.narration ?? null
      const usage = state?.tokens ?? { input: 0, output: 0 }
      const embedded = variant === 'tab'

      const header = h(
        'div',
        {
          ...(dragProps ?? {}),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: embedded ? '10px 14px' : '9px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            cursor: dragProps ? 'grab' : 'default',
            touchAction: 'none',
            userSelect: 'none',
            flex: '0 0 auto',
          },
        },
        showSettings
          ? [
              h(
                'button',
                {
                  key: 'back',
                  type: 'button',
                  onClick: () => setShowSettings(false),
                  className: 'dsh-observer-btn',
                  style: { ...headerBtnStyle, fontSize: 12, padding: '3px 8px' },
                },
                '← 返回',
              ),
              h('span', { key: 'title', style: { fontWeight: 600, fontSize: 12.5 } }, '旁路观察设置'),
              h('span', { key: 'spacer', style: { flex: 1 } }),
              onCollapse
                ? h(
                    'button',
                    { key: 'collapse', type: 'button', onClick: onCollapse, title: '收起', className: 'dsh-observer-btn', style: headerBtnStyle },
                    '—',
                  )
                : null,
            ]
          : [
              h(StatusDot, { key: 'dot', state }),
              h('span', { key: 'title', style: { fontWeight: 600, fontSize: 12.5 } }, '旁路观察'),
              h(
                'span',
                { key: 'status', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                statusText(state),
              ),
              h('span', { key: 'spacer', style: { flex: 1 } }),
              h(
                'button',
                {
                  key: 'refresh',
                  type: 'button',
                  onClick: refreshNow,
                  disabled: refreshing,
                  title: '立即播报一次',
                  className: 'dsh-observer-btn',
                  style: { ...headerBtnStyle, cursor: refreshing ? 'default' : 'pointer', opacity: refreshing ? 0.5 : 1 },
                },
                refreshing ? '…' : '↻',
              ),
              h(
                'button',
                { key: 'settings', type: 'button', onClick: () => setShowSettings(true), title: '设置', className: 'dsh-observer-btn', style: headerBtnStyle },
                '⚙',
              ),
              onCollapse
                ? h(
                    'button',
                    { key: 'collapse', type: 'button', onClick: onCollapse, title: '收起', className: 'dsh-observer-btn', style: headerBtnStyle },
                    '—',
                  )
                : null,
            ],
      )

      const body = h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: 'dsh-observer-scroll',
            style: { flex: 1, overflowY: 'auto', padding: embedded ? '12px 14px' : '10px 12px', minHeight: 0 },
          },
          state?.error
            ? h(
                'div',
                { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8, wordBreak: 'break-word' } },
                state.error,
              )
            : null,
          refreshError !== ''
            ? h(
                'div',
                { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8, wordBreak: 'break-word' } },
                refreshError,
              )
            : null,
          narration !== null
            ? h(
                'div',
                null,
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 5,
                      fontSize: 11,
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  h('span', null, formatTime(narration.at)),
                  narration.usage
                    ? h(
                        'span',
                        null,
                        `· ${formatTokens(narration.usage.input)} in / ${formatTokens(narration.usage.output)} out`,
                      )
                    : null,
                ),
                h(
                  'div',
                  {
                    style: {
                      fontSize: 13,
                      lineHeight: 1.65,
                      background: 'var(--dsw-alias-bg-layer-1)',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: 10,
                      padding: '9px 11px',
                    },
                  },
                  renderMarkdown(narration.text),
                ),
              )
            : h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    padding: '20px 0 16px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                h('div', { style: { fontSize: 22, opacity: 0.45, lineHeight: 1 } }, '◌'),
                h(
                  'div',
                  { style: { fontSize: 12.5 } },
                  state?.running
                    ? '正在观察，稍后给出第一段播报…'
                    : state?.session
                      ? '本轮已完成 · 暂无播报'
                      : '当前没有进行中的对话',
                ),
                !state?.running && !state?.session
                  ? h('div', { style: { fontSize: 11, marginTop: 2 } }, '在左侧开始一个新对话，这里会自动播报进度')
                  : null,
              ),
          h(
            'button',
            {
              type: 'button',
              onClick: refreshNow,
              disabled: refreshing,
              className: 'dsh-observer-btn',
              style: {
                marginTop: 10,
                width: '100%',
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 12.5,
                fontFamily: 'inherit',
                cursor: refreshing ? 'default' : 'pointer',
                opacity: refreshing ? 0.6 : 1,
              },
            },
            refreshing ? '正在播报…' : '立即播报当前状况',
          ),
          answer !== null
            ? h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    padding: '8px 10px',
                    borderRadius: 9,
                    background: 'var(--dsw-alias-bg-layer-1)',
                    border: '1px solid var(--dsw-alias-border-l2)',
                  },
                },
                h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 3 } }, '回答'),
                answer.error
                  ? h('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary)' } }, answer.error)
                  : h('div', { style: { fontSize: 12.5 } }, renderMarkdown(answer.text)),
              )
            : null,
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderTop: '1px solid var(--dsw-alias-border-l2)',
              flex: '0 0 auto',
            },
          },
          h('input', {
            className: 'dsh-observer-input',
            style: { ...inputStyle, flex: 1 },
            value: question,
            placeholder: '问它主对话怎么样了…',
            onChange: (event) => setQuestion(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void ask()
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: ask,
              disabled: asking || question.trim() === '',
              style: {
                padding: '6px 12px',
                minHeight: 32,
                borderRadius: 8,
                border: 'none',
                cursor: asking || question.trim() === '' ? 'default' : 'pointer',
                background: 'var(--dsw-alias-brand-primary)',
                color: 'var(--dsw-alias-label-primary-inverted, #fff)',
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: 'inherit',
                opacity: asking || question.trim() === '' ? 0.5 : 1,
              },
            },
            asking ? '…' : '发送',
          ),
        ),
        h(
          'div',
          {
            style: {
              padding: '0 12px 8px',
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              display: 'flex',
              justifyContent: 'space-between',
              flex: '0 0 auto',
            },
          },
          h('span', null, `本次会话 ≈ ${formatTokens(usage.input)} in / ${formatTokens(usage.output)} out`),
          h(
            'span',
            null,
            state?.config
              ? state.config.intervalSeconds === 0
                ? '手动播报'
                : `每 ${state.config.intervalSeconds} 秒`
              : '',
          ),
        ),
      )

      return h(
        React.Fragment,
        null,
        header,
        showSettings && state?.config
          ? h(SettingsPanel, {
              config: state.config,
              onSaved: (next) => setState((prev) => (prev === null ? prev : { ...prev, config: next })),
              onClose: () => setShowSettings(false),
            })
          : body,
      )
    }

    // -----------------------------------------------------------------------
    // 悬浮窗
    // -----------------------------------------------------------------------

    function ObserverOverlay() {
      const { state, setState, sessionId } = useObserverState(null)
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(() => loadPos() ?? defaultSeat())
      const [mobile, setMobile] = React.useState(() => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT)
      const [vh, setVh] = React.useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight))
      const [mobileSeat, setMobileSeat] = React.useState(() => defaultSeat())
      const [tabActive, setTabActive] = React.useState(false)
      const posRef = React.useRef(pos)
      const dragRef = React.useRef(null)
      const draggedRef = React.useRef(false)

      React.useEffect(() => {
        ensureStyle()
      }, [])

      // 窄屏适配
      React.useEffect(() => {
        const onResize = () => {
          setMobile(window.innerWidth < MOBILE_BREAKPOINT)
          setVh(window.innerHeight)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // Esc 关闭（焦点可能不在卡片内，用全局监听）
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      // 移动端座位：布局稳定后再量一次，避免量到 hero 态的旧位置
      React.useEffect(() => {
        if (!mobile) return undefined
        const update = () => setMobileSeat(defaultSeat())
        update()
        const t1 = setTimeout(update, 300)
        const t2 = setTimeout(update, 1200)
        window.addEventListener('resize', update)
        return () => {
          clearTimeout(t1)
          clearTimeout(t2)
          window.removeEventListener('resize', update)
        }
      }, [mobile])

      // 顶部「观察」栏打开时，悬浮窗让位（避免和栏内输入框重叠）
      React.useEffect(() => {
        const check = () => {
          try {
            const el = document.querySelector("[role='tab'][aria-selected='true']")
            setTabActive(el !== null && el.textContent.trim() === '观察')
          } catch {
            setTabActive(false)
          }
        }
        check()
        const timer = setInterval(check, 1000)
        return () => clearInterval(timer)
      }, [])

      // 用户没拖过时，跟着输入框位置走（首屏 hero → 对话态会移动）
      React.useEffect(() => {
        if (loadPos() !== null) return undefined
        const sync = () => {
          if (draggedRef.current) return
          const seat = defaultSeat()
          const prev = posRef.current
          if (Math.abs(prev.left - seat.left) < 4 && Math.abs(prev.bottom - seat.bottom) < 4) return
          posRef.current = seat
          setPos(seat)
        }
        const timer = setInterval(sync, 2000)
        const first = setTimeout(sync, 800)
        window.addEventListener('resize', sync)
        return () => {
          clearInterval(timer)
          clearTimeout(first)
          window.removeEventListener('resize', sync)
        }
      }, [])

      const onPointerDown = (event) => {
        if (mobile || event.button !== 0) return
        // 头部里的按钮不参与拖拽，否则 setPointerCapture 会吞掉 click
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        const target = event.currentTarget
        try {
          target.setPointerCapture?.(event.pointerId)
        } catch {
          // 忽略
        }
        draggedRef.current = true
        dragRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          left: posRef.current.left,
          bottom: posRef.current.bottom,
        }
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null) return
        const next = {
          left: clamp(drag.left + (event.clientX - drag.startX), 8, Math.max(8, window.innerWidth - CARD_W - 8)),
          bottom: clamp(drag.bottom - (event.clientY - drag.startY), 8, Math.max(8, window.innerHeight - CARD_H - 8)),
        }
        posRef.current = next
        setPos(next)
      }

      const onPointerUp = () => {
        if (dragRef.current === null) return
        dragRef.current = null
        savePos(posRef.current)
      }

      // 配置未加载前不渲染，避免闪一下；开关关闭时整个悬浮窗不出现
      const cfg = state?.config ?? null
      if (cfg === null) return null
      if (cfg.overlayEnabled === false) return null
      if (mobile && cfg.mobileOverlayEnabled !== true) return null
      if (tabActive) return null

      const narration = state?.narration ?? null
      const snippet = narration?.text ? narration.text.replace(/\s+/g, ' ').slice(0, 60) : '等待第一次播报…'

      // 收起态：小胶囊
      if (!open) {
        return h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen(true),
            title: '点击展开旁路观察（Enter 展开）',
            className: 'dsh-observer-pill',
            'aria-expanded': false,
            'aria-label': `旁路观察：${snippet}`,
            style: {
              position: 'fixed',
              left: mobile ? '50%' : pos.left,
              bottom: mobile ? 12 : pos.bottom,
              transform: mobile ? 'translateX(-50%)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              maxWidth: mobile ? 'calc(100vw - 24px)' : 300,
              padding: '7px 12px',
              borderRadius: 999,
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)',
              cursor: 'pointer',
              zIndex: 9000,
              pointerEvents: 'auto',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12,
              userSelect: 'none',
              font: 'inherit',
              textAlign: 'left',
            },
          },
          h(StatusDot, { state }),
          h('span', { style: { fontWeight: 600, flex: '0 0 auto' } }, '旁路观察'),
          h(
            'span',
            {
              style: {
                color: 'var(--dsw-alias-label-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            snippet,
          ),
        )
      }

      // 展开态：卡片
      const seatBottom = mobile ? mobileSeat.bottom : pos.bottom
      const maxBottom = Math.max(8, vh - 240 - 16)
      const effBottom = Math.min(seatBottom, maxBottom)
      const availH = Math.max(200, vh - effBottom - 16)
      const cardMaxH = Math.min(560, availH)
      return h(
        'div',
        {
          className: 'dsh-observer-card',
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setOpen(false)
            }
          },
          style: {
            position: 'fixed',
            left: mobile ? 8 : pos.left,
            right: mobile ? 8 : 'auto',
            bottom: effBottom,
            width: mobile ? 'auto' : 380,
            maxWidth: 'calc(100vw - 16px)',
            maxHeight: cardMaxH,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 16,
            boxShadow: 'rgba(0,0,0,.04) 0 0 0 .5px, rgba(0,0,0,.04) 0 3px 8px, rgba(0,0,0,.05) 0 0 20px',
            boxSizing: 'border-box',
            zIndex: 9000,
            pointerEvents: 'auto',
            overflow: 'hidden',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 13,
            lineHeight: 1.55,
          },
        },
        h(ObserverPanel, {
          state,
          setState,
          sessionId,
          variant: 'overlay',
          onCollapse: () => setOpen(false),
          dragProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
        }),
      )
    }

    // -----------------------------------------------------------------------
    // 顶部「观察」栏
    // -----------------------------------------------------------------------

    function ObserverTab(props) {
      const { state, setState, sessionId } = useObserverState(props?.sessionId ?? null)

      React.useEffect(() => {
        ensureStyle()
      }, [])

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 13,
            lineHeight: 1.55,
          },
        },
        h(ObserverPanel, { state, setState, sessionId, variant: 'tab' }),
      )
    }

    // -----------------------------------------------------------------------
    // 挂载
    // -----------------------------------------------------------------------

    return {
      inject: ['slots'],

      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'observer-overlay',
              order: 120,
            },
            ObserverOverlay,
          ),
        )
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'observer',
              order: 26,
              label: () => '观察',
            },
            ObserverTab,
          ),
        )
      },
    }
  },
})
