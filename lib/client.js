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
    // 「观察」栏在 ≥900px 时用两栏布局；悬浮窗始终单栏
    const WIDE_BREAKPOINT = 900
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

    /** 输入框（composer）卡片的几何，用于把收起态卡片贴到输入框右侧。 */
    function composerBox() {
      try {
        const input =
          document.querySelector('[data-composer-input]') ??
          document.querySelector('[data-composer-seat] [contenteditable="true"]') ??
          document.querySelector('[contenteditable="true"]')
        if (input !== null) {
          const box = input.getBoundingClientRect()
          if (box.width > 0) {
            const card = input.closest('[class*="_card"]')
            const outer = card !== null ? card.getBoundingClientRect() : box
            return { left: outer.left, right: outer.right, top: outer.top, bottom: outer.bottom }
          }
        }
      } catch {
        // 用兜底值
      }
      return null
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
        // 按钮普遍内联了 background，普通 background 规则会被内联样式压过；
        // 用 inset box-shadow 叠一层悬停底色，不受内联 background 影响。
        '.dsh-observer-btn:hover{box-shadow:inset 0 0 0 999px var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
        '.dsh-observer-btn:focus-visible,.dsh-observer-pill:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
        '.dsh-observer-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
        '.dsh-observer-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-1px}',
        '.dsh-observer-input::placeholder{color:var(--dsw-alias-label-secondary)}',
        '.dsh-observer-pill{transition:box-shadow .18s ease;box-shadow:0 6px 20px rgba(0,0,0,.14);box-sizing:border-box}',
        '.dsh-observer-pill:hover{box-shadow:0 10px 30px rgba(0,0,0,.22)}',
        '.dsh-observer-scroll{mask-image:linear-gradient(to bottom,#000 calc(100% - 24px),transparent);scrollbar-width:thin}',
        '@keyframes dsh-observer-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
        '.dsh-observer-card{animation:dsh-observer-in .18s ease;box-shadow:rgba(0,0,0,.04) 0 0 0 .5px,rgba(0,0,0,.04) 0 3px 8px,rgba(0,0,0,.05) 0 0 20px}',
        'body[data-ds-dark-theme] .dsh-observer-card{box-shadow:rgba(0,0,0,.5) 0 0 0 .5px,rgba(0,0,0,.45) 0 4px 12px,rgba(0,0,0,.4) 0 0 24px}',
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

    function Row({ label, children, hint, compact }) {
      const fs = 13
      const fsSmall = 11
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 } },
        h('div', { style: { fontSize: fs, color: 'var(--dsw-alias-label-secondary)' } }, label),
        children,
        hint !== undefined
          ? h('div', { style: { fontSize: fsSmall, color: 'var(--dsw-alias-label-secondary)' } }, hint)
          : null,
      )
    }

    const inputStyleFor = (compact) => ({
      width: '100%',
      boxSizing: 'border-box',
      padding: compact ? '5px 8px' : '6px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12.5,
      fontFamily: 'inherit',
    })
    const inputStyle = inputStyleFor(false)
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

    function Segmented({ value, options, onChange, compact }) {
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
                fontSize: compact ? 11 : 12,
                fontFamily: 'inherit',
                background: value === option.value ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                color: value === option.value ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                fontWeight: value === option.value ? 600 : 400,
                boxShadow:
                  value === option.value
                    ? 'inset 0 0 0 1px var(--dsw-alias-border-l3), 0 1px 3px rgba(0,0,0,.12)'
                    : 'none',
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

    function SettingsPanel({ config, onSaved, onClose, compact }) {
      const fs = 13
      const fsSmall = 11
      const fsTitle = 12.5
      const inputStyle = inputStyleFor(compact)
      const selectStyle = { ...inputStyle, cursor: 'pointer' }
      const [draft, setDraft] = React.useState(() => ({ ...config }))
      const configRef = React.useRef(config)
      const [providers, setProviders] = React.useState([])
      const [efforts, setEfforts] = React.useState([])
      const [apiKey, setApiKey] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState('')

      // 外部改了配置（例如点「暂停」）时同步草稿，避免开关显示旧值。
      // 注意：/state 每 2 秒轮询一次，每次都会带一个全新的 config 对象，
      // 所以不能按「对象身份变了」就整份覆盖草稿——那会把用户还没保存的
      // 改动每 2 秒冲掉一次（表现为"必须在一瞬间内点保存"）。
      // 正确做法：逐字段比较服务端这次到底改了哪些字段，只同步
      // 「服务端真的变了 且 用户本地没动过」的字段。
      React.useEffect(() => {
        const prev = configRef.current
        if (prev === config) return
        configRef.current = config
        setDraft((current) => {
          let next = null
          for (const key of Object.keys(config)) {
            const after = config[key]
            if (after !== null && typeof after === 'object') continue
            const before = prev?.[key]
            if (after === before) continue
            // 用户本地改过这个字段（和服务端上一份值不一致）→ 保留用户的输入
            if (current[key] !== before) continue
            if (next === null) next = { ...current }
            next[key] = after
          }
          return next === null ? current : next
        })
      }, [config])

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
            setMessage(
              json.warning === 'secret-save-failed'
                ? '已保存，但密钥写入失败'
                : json.warning === 'api-key-cleared'
                  ? '已保存；端点已变更，旧密钥已清除，请重新填写'
                  : '已保存',
            )
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
            // 只清 key，不顺手把未保存的草稿改动一起持久化
            body: JSON.stringify({ config: {}, clearApiKey: true }),
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
          {
            className: 'dsh-observer-scroll',
            style: {
              flex: 1,
              overflowY: 'auto',
              padding: '12px 12px 4px',
              width: '100%',
              maxWidth: 560,
              margin: '0 auto',
              boxSizing: 'border-box',
            },
          },
          h(
            Row,
            { label: '模型来源', compact },
            h(Segmented, {
              value: draft.modelMode,
              compact,
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
                  { key: 'provider', label: '提供商', compact },
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
                  { key: 'model', label: '模型', compact },
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
                      { key: 'effort', label: '思考强度', compact },
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
                  { key: 'base', label: '接口地址', compact, hint: 'OpenAI 兼容，填到 /v1 即可，自动补 /chat/completions' },
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
                  { key: 'cmodel', label: '模型 ID', compact },
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
                  { key: 'key', label: 'API Key', compact, hint: config.hasApiKey ? '已保存，留空则不修改' : '仅保存在本机' },
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
            { label: '播报频率', compact },
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
              { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: fs, color: 'var(--dsw-alias-label-secondary)' } }, '读取主对话思考'),
              h(
                'div',
                { style: { fontSize: fsSmall, color: 'var(--dsw-alias-label-secondary)' } },
                '开启后旁路模型能看到主模型最近的推理，判断更准',
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
              { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: fs, color: 'var(--dsw-alias-label-secondary)' } }, '启用播报'),
              h(
                'div',
                { style: { fontSize: fsSmall, color: 'var(--dsw-alias-label-secondary)' } },
                '关闭后不再自动调用，悬浮窗仍可手动刷新',
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
              { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: fs, color: 'var(--dsw-alias-label-secondary)' } }, '显示悬浮窗'),
              h(
                'div',
                { style: { fontSize: fsSmall, color: 'var(--dsw-alias-label-secondary)' } },
                '关闭后不再显示左下角胶囊，仍可从「观察」栏查看',
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
              { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: fs, color: 'var(--dsw-alias-label-secondary)' } }, '移动端显示悬浮窗'),
              h(
                'div',
                { style: { fontSize: fsSmall, color: 'var(--dsw-alias-label-secondary)' } },
                '默认关闭，避免小屏遮挡输入框',
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
                background: 'var(--dsw-alias-button-info-fill, var(--dsw-alias-brand-primary))',
                color: 'var(--dsw-alias-label-on-color, #fff)',
                fontSize: fsTitle,
                fontWeight: 600,
                fontFamily: 'inherit',
                opacity: saving ? 0.6 : 1,
              },
            },
            saving ? '保存中…' : '保存',
          ),
          message !== ''
            ? h('span', { style: { fontSize: fsSmall + 0.5, color: 'var(--dsw-alias-label-secondary)' } }, message)
            : dirty
              ? h('span', { style: { fontSize: fsSmall + 0.5, color: 'var(--dsw-alias-state-warn-primary)' } }, '未保存')
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
      const paused = state?.config?.enabled === false
      if (state?.error) color = 'var(--dsw-alias-state-error-primary)'
      else if (state?.busy) {
        color = 'var(--dsw-alias-state-warn-primary)'
        pulse = true
      } else if (paused) color = 'var(--dsw-alias-label-tertiary)'
      else if (state?.running) color = 'var(--dsw-alias-state-success-primary)'
      return h('span', {
        style: {
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          flex: '0 0 auto',
          animation: pulse ? 'dsh-observer-pulse 1.2s ease-in-out infinite' : 'none',
        },
      })
    }

    function statusText(state) {
      if (state === null) return '连接中'
      if (state.config && state.config.enabled === false) return '已暂停'
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
      const seqRef = React.useRef(0)
      const sidRef = React.useRef(sessionIdOverride ?? null)

      React.useEffect(() => {
        let alive = true
        let inflight = false
        const tick = async () => {
          if (inflight) return
          inflight = true
          const sid = sessionIdOverride ?? currentSessionId()
          // 换会话：立刻清空旧播报，避免「卡着上一个会话的输出」
          if (sid !== sidRef.current) {
            sidRef.current = sid
            setSessionId(sid)
            // 只清会话相关字段，保留 config（全局配置与会话无关），
            // 否则每次切会话悬浮窗都会整体消失一下。
            setState((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    session: null,
                    narration: null,
                    history: [],
                    tokens: { input: 0, output: 0 },
                    error: null,
                    running: false,
                    busy: false,
                  },
            )
          }
          const seq = ++seqRef.current
          try {
            const query = sid === null ? '' : `?session=${encodeURIComponent(sid)}`
            const res = await fetch(`${API}/state${query}`, { headers: { accept: 'application/json' } })
            if (!res.ok) return
            const body = await res.json()
            // 过期响应（会话已切走 / 有更新的请求）直接丢弃，避免来回闪
            if (!alive || seq !== seqRef.current) return
            const nowSid = sessionIdOverride ?? currentSessionId()
            if (nowSid !== sid) return
            if (body?.ok && (sid === null || body.session === null || body.session === sid)) setState(body)
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

    function ObserverPanel({ state, setState, sessionId, variant, onCollapse, dragProps, onSettingsOpenChange }) {
      // 悬浮窗比「观察」栏窄，字号整体收一档；观察栏保持原样
      const compact = variant === 'overlay'
      const fs = 13
      const fsSmall = 11
      const fsTitle = 12.5
      const [showSettings, setShowSettings] = React.useState(false)
      React.useEffect(() => {
        onSettingsOpenChange?.(showSettings)
      }, [showSettings, onSettingsOpenChange])
      const [question, setQuestion] = React.useState('')
      const [answer, setAnswer] = React.useState(null)
      const [asking, setAsking] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const [refreshError, setRefreshError] = React.useState('')
      const [copied, setCopied] = React.useState(false)
      const [historyOpen, setHistoryOpen] = React.useState(false)
      const [viewAt, setViewAt] = React.useState(null)
      const [wide, setWide] = React.useState(() => typeof window !== 'undefined' && window.innerWidth >= WIDE_BREAKPOINT)

      React.useEffect(() => {
        const onResize = () => setWide(window.innerWidth >= WIDE_BREAKPOINT)
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // 换会话时清掉上一轮的追问回答 / 历史浏览位置
      React.useEffect(() => {
        setAnswer(null)
        setViewAt(null)
        setHistoryOpen(false)
      }, [sessionId])

      const toggleEnabled = async () => {
        const current = state?.config
        if (!current) return
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: { enabled: !current.enabled } }),
          })
          const body = await res.json()
          if (body?.ok && body.config) setState((prev) => (prev === null ? prev : { ...prev, config: body.config }))
        } catch {
          // 忽略，下一轮轮询会纠正
        }
      }

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
            setState((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    narration: body.narration,
                    history: Array.isArray(body.history) ? body.history : prev.history,
                    tokens: body.tokens ?? prev.tokens,
                    error: null,
                  },
            )
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
          setAnswer(
            body?.ok
              ? { text: typeof body.answer === 'string' ? body.answer : '（空回答）' }
              : { error: body?.error ?? '提问失败' },
          )
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
              h('span', { key: 'title', style: { fontWeight: 600, fontSize: fsTitle } }, '旁路观察设置'),
              h('span', { key: 'spacer', style: { flex: 1 } }),
              onCollapse
                ? h(
                    'button',
                    { key: 'collapse', type: 'button', onClick: onCollapse, title: '收起', 'aria-label': '收起旁路观察', className: 'dsh-observer-btn', style: headerBtnStyle },
                    '—',
                  )
                : null,
            ]
          : [
              h(StatusDot, { key: 'dot', state }),
              h('span', { key: 'title', style: { fontWeight: 600, fontSize: fsTitle } }, '旁路观察'),
              h(
                'span',
                { key: 'status', style: { fontSize: fsSmall, color: 'var(--dsw-alias-label-secondary)' } },
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
                  'aria-label': '立即播报一次',
                  className: 'dsh-observer-btn',
                  style: { ...headerBtnStyle, cursor: refreshing ? 'default' : 'pointer', opacity: refreshing ? 0.5 : 1 },
                },
                refreshing ? '…' : '↻',
              ),
              h(
                'button',
                { key: 'settings', type: 'button', onClick: () => setShowSettings(true), title: '设置', 'aria-label': '旁路观察设置', className: 'dsh-observer-btn', style: headerBtnStyle },
                '⚙',
              ),
              onCollapse
                ? h(
                    'button',
                    { key: 'collapse', type: 'button', onClick: onCollapse, title: '收起', 'aria-label': '收起旁路观察', className: 'dsh-observer-btn', style: headerBtnStyle },
                    '—',
                  )
                : null,
            ],
      )

      // ---- 播报历史 / 当前展示 ----
      const history = Array.isArray(state?.history) ? state.history : []
      // 用播报时间戳做稳定引用：宿主 push 后 splice 会让下标整体左移
      const browsing = viewAt !== null && history.some((item) => item.at === viewAt)
      const shown = browsing ? history.find((item) => item.at === viewAt) : narration

      const ERROR_TEXT = {
        'no-session': '这个会话还没有产生事件，稍后再试',
        busy: '正在播报中，请稍候',
        'question-too-long': '问题太长了，请精简一下',
        'payload-too-large': '请求内容过大',
        'api-key-cleared': '端点已变更，旧密钥已清除，请重新填写',
        'secret-save-failed': '密钥写入失败',
        'no-model': '还没有选择旁路模型',
        'no-api-key': '自定义端点还没有填 API Key',
        'bad-base-url': '接口地址不合法',
        timeout: '旁路模型响应超时，稍后再试',
        aborted: '播报被中断',
        failed: '播报失败',
      }
      const errorLine = (text) =>
        h(
          'div',
          {
            role: 'status',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: fsSmall + 0.5,
              color: 'var(--dsw-alias-state-error-primary)',
              marginBottom: 8,
              wordBreak: 'break-word',
            },
          },
          h('span', { style: { flex: 1 } }, ERROR_TEXT[text] ?? text),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-observer-btn',
              title: '重试',
              style: { ...headerBtnStyle, fontSize: fsSmall, padding: '1px 7px', minHeight: 24, flex: '0 0 auto' },
              onClick: () => {
                setRefreshError('')
                void refreshNow()
              },
            },
            '重试',
          ),
        )

      const narrationCard =
        shown !== null
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
                    fontSize: fsSmall,
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                h('span', null, formatTime(shown.at)),
                shown.usage
                  ? h('span', null, `· ${formatTokens(shown.usage.input)} in / ${formatTokens(shown.usage.output)} out`)
                  : null,
                h('span', { style: { flex: 1 } }),
                history.length > 1
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-observer-btn',
                        title: '查看历史播报',
                        style: { ...headerBtnStyle, fontSize: fsSmall, padding: '1px 7px', minHeight: 24 },
                        onClick: () => {
                          setHistoryOpen((prev) => !prev)
                          setViewAt(null)
                        },
                      },
                      historyOpen ? '收起历史' : `历史 ${history.length}`,
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-observer-btn',
                    title: '复制这条播报',
                    style: { ...headerBtnStyle, fontSize: fsSmall, padding: '1px 7px', minHeight: 24 },
                    onClick: async () => {
                      try {
                        await navigator.clipboard.writeText(shown.text)
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1500)
                      } catch {
                        setCopied(false)
                      }
                    },
                  },
                  copied ? '已复制' : '复制',
                ),
              ),
              h(
                'div',
                {
                  style: {
                    fontSize: fs,
                    lineHeight: 1.6,
                    background: 'var(--dsw-alias-bg-layer-1)',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    borderRadius: 10,
                    padding: '9px 11px',
                  },
                },
                renderMarkdown(shown.text),
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
              h('div', { style: { fontSize: compact ? 20 : 22, opacity: 0.45, lineHeight: 1 } }, '◌'),
              h(
                'div',
                { style: { fontSize: fsTitle } },
                state?.running
                  ? '正在观察，稍后给出第一段播报…'
                  : state?.session
                    ? '本轮已完成 · 暂无播报'
                    : sessionId !== null
                      ? '正在等待这个会话的第一条事件'
                      : '当前没有进行中的对话',
              ),
              !state?.running && !state?.session && sessionId === null
                ? h('div', { style: { fontSize: fsSmall, marginTop: 2 } }, '在左侧开始一个新对话，这里会自动播报进度')
                : null,
            )

      const historyList = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: fsSmall,
              color: 'var(--dsw-alias-label-secondary)',
              marginBottom: 2,
            },
          },
          h('span', null, `最近 ${history.length} 条播报 · 点一条回看`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-observer-btn',
              title: '收起历史',
              style: { ...headerBtnStyle, fontSize: fsSmall, padding: '1px 7px', minHeight: 24 },
              onClick: () => setHistoryOpen(false),
            },
            '收起历史',
          ),
        ),
        ...history
          .slice()
          .reverse()
          .map((item) =>
            h(
              'button',
              {
                key: item.at,
                type: 'button',
                className: 'dsh-observer-btn',
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  width: '100%',
                  padding: '6px 9px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                },
                onClick: () => {
                  setViewAt(item.at)
                  setHistoryOpen(false)
                },
              },
              h('span', { style: { flex: '0 0 auto', fontSize: fsSmall, color: 'var(--dsw-alias-label-secondary)' } }, formatTime(item.at)),
              h(
                'span',
                { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                item.text.replace(/\s+/g, ' ').slice(0, 70),
              ),
            ),
          ),
      )

      const narrationArea = h(
        'div',
        {
          className: 'dsh-observer-scroll',
          'aria-live': 'polite',
          'aria-label': '旁路观察播报',
          style: { flex: 1, overflowY: 'auto', padding: embedded ? '12px 14px' : '10px 12px', minHeight: 0 },
        },
        state?.error ? errorLine(state.error) : null,
        refreshError !== '' ? errorLine(refreshError) : null,
        browsing
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-observer-btn',
                style: {
                  marginBottom: 8,
                  padding: '2px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontFamily: 'inherit',
                  fontSize: fsSmall,
                  cursor: 'pointer',
                },
                onClick: () => setViewAt(null),
              },
              '← 回到最新',
            )
          : null,
        historyOpen ? historyList : narrationCard,
      )

      const actionRow = h(
          'div',
          { style: { display: 'flex', gap: 6, padding: embedded ? '0 14px 12px' : '0 12px 10px', flex: '0 0 auto' } },
          h(
            'button',
            {
              type: 'button',
              onClick: refreshNow,
              disabled: refreshing,
              className: 'dsh-observer-btn',
              style: {
                flex: 1,
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: fsTitle,
                fontFamily: 'inherit',
                cursor: refreshing ? 'default' : 'pointer',
                opacity: refreshing ? 0.6 : 1,
              },
            },
            refreshing ? '正在播报…' : '立即播报当前状况',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: toggleEnabled,
              title: state?.config?.enabled ? '暂停自动播报（手动播报仍可用）' : '恢复自动播报',
              className: 'dsh-observer-btn',
              style: {
                flex: '0 0 auto',
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: fsTitle,
                fontFamily: 'inherit',
                cursor: 'pointer',
              },
            },
            state?.config?.enabled ? '暂停' : '继续',
          ),
      )

      const askHints =
        embedded
          ? h(
              'div',
              { style: { padding: wide ? '14px 12px 0' : '10px 12px 0' } },
              h(
                'div',
                { style: { fontSize: fsSmall, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
                '可以这样问：',
              ),
              h(
                'div',
                {
                  style: wide
                    ? { display: 'flex', flexDirection: 'column', gap: 6 }
                    : {
                        display: 'flex',
                        gap: 6,
                        overflowX: 'auto',
                        paddingBottom: 2,
                        scrollbarWidth: 'none',
                      },
                },
                ...['现在卡住了吗？', '接下来要做什么？', '刚才改动了哪些文件？'].map((q) =>
                  h(
                    'button',
                    {
                      key: q,
                      type: 'button',
                      className: 'dsh-observer-btn',
                      style: {
                        textAlign: 'left',
                        padding: '6px 9px',
                        borderRadius: 8,
                        border: '1px solid var(--dsw-alias-border-l2)',
                        background: 'transparent',
                        color: 'var(--dsw-alias-label-secondary)',
                        fontFamily: 'inherit',
                        fontSize: 12,
                        cursor: 'pointer',
                        flex: wide ? undefined : '0 0 auto',
                        whiteSpace: 'nowrap',
                      },
                      onClick: () => setQuestion(q),
                    },
                    q,
                  ),
                ),
              ),
            )
          : null

      const answerBlock =
        asking && answer === null
          ? h(
              'div',
              {
                role: 'status',
                style: {
                  margin: '12px 12px 8px',
                  padding: '8px 10px',
                  borderRadius: 9,
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  fontSize: 12.5,
                  color: 'var(--dsw-alias-label-secondary)',
                },
              },
              '正在问旁路模型…',
            )
          : answer !== null
          ? h(
              'div',
              {
                style: {
                  margin: '12px 12px 8px',
                  padding: '8px 10px',
                  borderRadius: 9,
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: fsSmall,
                    color: 'var(--dsw-alias-label-secondary)',
                    marginBottom: 3,
                  },
                },
                h('span', null, '回答'),
                h('span', { style: { flex: 1 } }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-observer-btn',
                    title: '清除回答',
                    'aria-label': '清除回答',
                    style: { ...headerBtnStyle, fontSize: fsSmall, padding: '1px 7px', minHeight: 24 },
                    onClick: () => setAnswer(null),
                  },
                  '×',
                ),
              ),
              answer.error
                ? h('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary)' } }, answer.error)
                : h('div', { style: { fontSize: 12.5 } }, renderMarkdown(answer.text)),
            )
          : null

      const askRow = h(
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
          'aria-label': '向旁路观察提问',
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
              background: 'var(--dsw-alias-button-info-fill, var(--dsw-alias-brand-primary))',
              color: 'var(--dsw-alias-label-on-color, #fff)',
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: 'inherit',
              opacity: asking || question.trim() === '' ? 0.5 : 1,
            },
          },
          asking ? '…' : '发送',
        ),
      )

      const footerStats = h(
        'div',
        {
          style: {
            padding: '0 12px 8px',
            fontSize: fsSmall,
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
      )

      // 宽屏（横屏）下「观察」栏改成左右两栏：左边看播报，右边追问与统计；
      // 窄屏（竖屏）保持原来的单栏，悬浮窗也始终单栏。
      const body =
        embedded && wide
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
              h(
                'div',
                { style: { display: 'flex', flex: 1, minHeight: 0 } },
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
                  narrationArea,
                  actionRow,
                ),
                h(
                  'div',
                  {
                    style: {
                      width: 320,
                      flex: '0 0 320px',
                      borderLeft: '1px solid var(--dsw-alias-border-l2)',
                      display: 'flex',
                      flexDirection: 'column',
                      minHeight: 0,
                    },
                  },
                  h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } }, askHints, answerBlock),
                  askRow,
                ),
              ),
              footerStats,
            )
          : h(React.Fragment, null, narrationArea, embedded ? askHints : null, actionRow, answerBlock, askRow, footerStats)

      return h(
        React.Fragment,
        null,
        header,
        showSettings && state?.config
          ? h(SettingsPanel, {
              config: state.config,
              compact,
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
      const [settingsOpen, setSettingsOpen] = React.useState(false)
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

      // 移动端座位：布局稳定后再量一次，避免量到 hero 态的旧位置。
      // 每次展开卡片时也重量一次——会话加载后 composer 会从 hero 位置移到底部。
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
      }, [mobile, open])

      // 顶部「观察」栏打开时，悬浮窗让位（避免和栏内输入框重叠）。
      // 用 ObserverTab 挂载时设置的模块级标志，而不是轮询 DOM 猜哪个 tab 选中。
      React.useEffect(() => {
        const check = () => setTabActive(window.__dshObserverTabActive === true)
        check()
        const timer = setInterval(check, 500)
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
        const drag = dragRef.current
        if (drag === null) return
        dragRef.current = null
        // 只有真的移动过才算拖拽：单纯点一下头部不应永久关闭「跟随输入框」
        const moved =
          Math.abs(posRef.current.left - drag.left) > 2 ||
          Math.abs(posRef.current.bottom - drag.bottom) > 2
        if (moved) {
          draggedRef.current = true
          savePos(posRef.current)
        }
      }

      // 配置未加载前不渲染，避免闪一下；开关关闭时整个悬浮窗不出现
      const cfg = state?.config ?? null
      if (cfg === null) return null
      if (cfg.overlayEnabled === false) return null
      if (mobile && cfg.mobileOverlayEnabled !== true) return null
      if (tabActive) return null

      const narration = state?.narration ?? null
      const snippet = narration?.text ? narration.text.replace(/\s+/g, ' ').slice(0, 90) : '等待第一次播报…'

      // 收起态始终贴在输入框右侧；右侧留白不足时把卡片压窄，绝不上移到输入框上方
      const box = composerBox()
      const vw = window.innerWidth
      const gap = 8
      const MIN_W = 36
      const gutter = box !== null ? vw - box.right - gap * 2 : 0
      const cardW = box !== null ? Math.max(MIN_W, Math.min(240, gutter)) : 200
      const cardLeft = box !== null ? Math.min(box.right + gap, vw - cardW - 8) : 24
      // 留白连最小宽度都放不下时，卡片会压到输入框右缘：抬到发送按钮上方，避免挡住它
      const tight = box !== null && cardLeft < box.right + gap
      const cardBottom = box !== null
        ? Math.max(12, vh - box.bottom + (tight ? 44 : 0))
        : 96
      const narrow = !mobile && cardW < 96
      // 压到输入框右缘时，卡片高度限制在「输入框顶 → 发送按钮上沿」之间，避免顶到上方的回到底部按钮
      const tightMaxH = tight ? Math.max(40, box.bottom - box.top - 44) : null
      const expandedLeft = draggedRef.current
        ? pos.left
        : Math.max(8, Math.min(cardLeft + cardW - 380, vw - 380 - 12))

      // 收起态：贴在输入框右侧的窄卡片（文字换行，最多 3 行）
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
              left: mobile ? '50%' : cardLeft,
              bottom: mobile ? mobileSeat.bottom : cardBottom,
              transform: mobile ? 'translateX(-50%)' : 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: narrow ? 'center' : 'stretch',
              gap: narrow ? 2 : 3,
              width: mobile ? 'min(320px, calc(100vw - 24px))' : cardW,
              maxWidth: 'none',
              maxHeight: tightMaxH ?? undefined,
              overflow: tightMaxH !== null ? 'hidden' : undefined,
              padding: narrow ? '6px 5px' : '7px 10px',
              borderRadius: 12,
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)',
              cursor: 'pointer',
              zIndex: 1100,
              pointerEvents: 'auto',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 11,
              lineHeight: 1.4,
              userSelect: 'none',
              fontFamily: 'inherit',
              textAlign: 'left',
            },
          },
          narrow
            ? h(
                'span',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 3,
                    width: '100%',
                  },
                },
                h(StatusDot, { state }),
                h(
                  'span',
                  {
                    style: {
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      columnGap: 1,
                      rowGap: 0,
                      fontWeight: 600,
                      lineHeight: 1.3,
                      textAlign: 'center',
                      letterSpacing: 0,
                    },
                  },
                  ...'旁路观察'.split('').map((ch, i) => h('span', { key: i }, ch)),
                ),
              )
            : h(
                'span',
                { style: { display: 'flex', alignItems: 'center', gap: 5 } },
                h(StatusDot, { state }),
                h('span', { style: { fontWeight: 600 } }, '旁路观察'),
              ),
          narrow
            ? null
            : h(
                'span',
                {
                  style: {
                    color: 'var(--dsw-alias-label-secondary)',
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    wordBreak: 'break-word',
                    width: '100%',
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
            left: mobile ? 8 : expandedLeft,
            right: mobile ? 8 : 'auto',
            bottom: effBottom,
            maxHeight: settingsOpen
              ? Math.max(240, Math.min(window.innerHeight - effBottom - 16, window.innerHeight - 32))
              : cardMaxH,
            width: mobile ? 'auto' : 380,
            maxWidth: 'calc(100vw - 16px)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 16,

            boxSizing: 'border-box',
            zIndex: 1100,
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
          onSettingsOpenChange: setSettingsOpen,
          dragProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
        }),
      )
    }

    // -----------------------------------------------------------------------
    // 顶部「观察」栏
    // -----------------------------------------------------------------------

    function ObserverTab(props) {
      const { state, setState, sessionId } = useObserverState(props?.sessionId ?? null)
      const rootRef = React.useRef(null)
      const [maxH, setMaxH] = React.useState(null)

      React.useEffect(() => {
        ensureStyle()
      }, [])

      // 宿主 viewArea 是 flex:1 0 auto + overflow:visible，会随内容长高，
      // 导致 tab 里的滚动区失效、按钮行被 composer 盖住。这里量出「顶部到 composer 上沿」
      // 的可用高度，直接夹住根节点。
      React.useLayoutEffect(() => {
        const measure = () => {
          const el = rootRef.current
          if (el === null) return
          const top = el.getBoundingClientRect().top
          const seat = document.querySelector('[data-composer-seat]')
          const composerH = seat === null ? 0 : seat.getBoundingClientRect().height
          const avail = window.innerHeight - top - composerH - 8
          setMaxH(Math.max(240, Math.round(avail)))
        }
        measure()
        const t1 = setTimeout(measure, 300)
        const t2 = setTimeout(measure, 1200)
        window.addEventListener('resize', measure)
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        const seat = document.querySelector('[data-composer-seat]')
        if (ro !== null && seat !== null) ro.observe(seat)
        return () => {
          clearTimeout(t1)
          clearTimeout(t2)
          window.removeEventListener('resize', measure)
          ro?.disconnect()
        }
      }, [])

      // 挂载即代表「观察」栏是当前激活的 view：通知悬浮窗让位
      React.useEffect(() => {
        window.__dshObserverTabActive = true
        return () => {
          window.__dshObserverTabActive = false
        }
      }, [])

      return h(
        'div',
        {
          ref: rootRef,
          style: {
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 auto',
            minHeight: 0,
            ...(maxH === null ? {} : { height: maxH, maxHeight: maxH, overflow: 'hidden' }),
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
        ctx.effect?.(() => () => {
          try {
            document.getElementById(STYLE_ID)?.remove()
          } catch {
            // 卸载时 DOM 可能已不可用
          }
        })
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
