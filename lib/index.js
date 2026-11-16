/**
 * dsh-observer — 旁路观察者（宿主半侧）
 *
 * 设计要点：
 * 1. 只读：订阅全局 `session/event`，把主会话的事件压成一份紧凑的事件流，
 *    不往会话里写任何东西，也不调用 agent loop，所以完全不干涉主对话。
 * 2. 旁路模型：用 `ctx.llm.stream()` 直调另一个 provider/model（或自定义
 *    OpenAI 兼容端点），拿到一段中文进度播报。
 * 3. 定时：一个 5 秒的全局 tick，按每个会话自己的频率决定是否该播报。
 * 4. 通道：`/api/observer/*` 给浏览器半侧的悬浮窗读写；不做 loopback 限制，
 *    远端经反代访问同样可用。
 */
import { loadConfig, saveConfig, loadSecret, saveSecret } from './config-store.js'

export const name = 'observer'
export const inject = ['llm']

const DEFAULTS = Object.freeze({
  enabled: true,
  overlayEnabled: true,
  mobileOverlayEnabled: false,
  intervalSeconds: 0,
  thinking: true,
  modelMode: 'provider',
  provider: '',
  model: '',
  reasoningEffort: '',
  customBaseUrl: '',
  customModel: '',
  maxTranscriptChars: 6000,
  maxReasoningChars: 2000,
  language: 'zh',
})

const INTERVAL_CHOICES = Object.freeze([0, 30, 60, 120, 180, 300, 600])
const TICK_MS = 5000
const CALL_TIMEOUT_MS = 45000
const FIRST_DELAY_CAP_SECONDS = 20
const MAX_ENTRIES = 60
const MAX_ENTRY_CHARS = 2000
const MAX_TOTAL_CHARS = 14000
const MAX_HISTORY = 10
const LONG_TURN_MS = 30000
const CLOSING_GAP_MS = 15000
const CLOSING_DELAY_MS = 1200
const MAX_QUESTION_CHARS = 2000
const MAX_API_KEY_CHARS = 512

const SYSTEM_PROMPT_ZH = `你是一个旁路观察者，正在实时观察另一个 AI 助手（下称"主对话"）的工作过程。你看不到它的界面，只能看到它最近的事件流。

请根据下面提供的信息，用中文写一段简短的进度播报，包含三点：
1. 刚刚完成了什么（具体到文件、命令、结论，不要只说"做了一些操作"）
2. 接下来准备做什么
3. 有没有卡住或出错（没有就不写）

要求：
- 只写结论，不要罗列工具名或参数
- 控制在 120 字以内，用 2-3 句话
- 只根据已有信息推断，不要编造没发生的事；信息不足时直说"暂时看不出明确进展"
- 这是旁路播报，不要向主对话提问，也不要给主对话下指令`

const SYSTEM_PROMPT_EN = `You are a sidecar observer watching another AI assistant (the "main conversation") work in real time. You cannot see its UI, only its recent event stream.

Write a short progress update in English with three points:
1. What was just completed (name files, commands, conclusions — not "did some work")
2. What it plans to do next
3. Whether it looks stuck or errored (omit if not)

Rules:
- Conclusions only; do not list tool names or arguments
- At most 120 words, 2-3 sentences
- Infer only from the given information; never invent events; say "no clear progress visible yet" when unsure
- This is a sidecar report: do not ask the main conversation questions or give it instructions`

const ASK_PROMPT_ZH = `你是一个旁路观察者，正在观察另一个 AI 助手（主对话）的工作过程。用户会向你提问主对话的进展。

请根据下面提供的事件流，用中文回答用户的问题。要求：
- 只根据已有信息回答，不要编造
- 简洁，控制在 150 字以内
- 如果信息不足，直说"从目前的信息看不出来"`

const ASK_PROMPT_EN = `You are a sidecar observer watching another AI assistant (the main conversation). The user asks you about its progress.

Answer in English using only the event stream below. Be concise (under 150 words). If the information is insufficient, say "I cannot tell from the current information".`

const LABELS = {
  zh: { user: '用户/上下文', assistant: '助手', tool: '工具调用', result: '工具结果', reasoning: '主对话最近的思考', events: '主对话最近的事件' },
  en: { user: 'user/context', assistant: 'assistant', tool: 'tool call', result: 'tool result', reasoning: 'recent reasoning', events: 'recent events' },
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeConfig(raw) {
  const out = { ...DEFAULTS }
  if (raw !== null && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(raw, key)) out[key] = raw[key]
    }
  }
  out.enabled = out.enabled !== false
  out.overlayEnabled = out.overlayEnabled !== false
  out.mobileOverlayEnabled = out.mobileOverlayEnabled === true
  out.thinking = out.thinking !== false
  out.intervalSeconds = clampInt(out.intervalSeconds, 0, 600, DEFAULTS.intervalSeconds)
  // 吸附到最近的预设档位，避免 select 显示错位
  let nearest = INTERVAL_CHOICES[0]
  for (const choice of INTERVAL_CHOICES) {
    if (Math.abs(choice - out.intervalSeconds) < Math.abs(nearest - out.intervalSeconds)) nearest = choice
  }
  out.intervalSeconds = nearest
  out.modelMode = out.modelMode === 'custom' ? 'custom' : 'provider'
  out.provider = typeof out.provider === 'string' ? out.provider : ''
  out.model = typeof out.model === 'string' ? out.model : ''
  out.reasoningEffort = typeof out.reasoningEffort === 'string' ? out.reasoningEffort : ''
  out.customBaseUrl = typeof out.customBaseUrl === 'string' ? out.customBaseUrl.trim() : ''
  if (out.customBaseUrl !== '') {
    try {
      const parsed = new URL(out.customBaseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') out.customBaseUrl = ''
    } catch {
      out.customBaseUrl = ''
    }
  }
  out.customModel = typeof out.customModel === 'string' ? out.customModel.trim() : ''
  out.maxTranscriptChars = clampInt(out.maxTranscriptChars, 1000, 20000, DEFAULTS.maxTranscriptChars)
  out.maxReasoningChars = clampInt(out.maxReasoningChars, 0, 8000, DEFAULTS.maxReasoningChars)
  out.language = out.language === 'en' ? 'en' : 'zh'
  return out
}

/** 从 content 数组里取正文。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 从 content 数组里取思考块。 */
function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 从持久化的 stream 记录里取思考块（content 里没有时兜底）。 */
function reasoningFromStream(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream) {
    if (record !== null && typeof record === 'object' && record.type === 'reasoning-chunks' && Array.isArray(record.texts)) {
      parts.push(record.texts.join(''))
    }
  }
  return parts.join('')
}

/** 工具参数压成一行短摘要。 */
function shortArgs(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  let text = raw
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const preferred = ['command', 'path', 'file_path', 'query', 'url', 'pattern', 'description', 'prompt']
      for (const key of preferred) {
        if (typeof parsed[key] === 'string' && parsed[key] !== '') {
          text = parsed[key]
          break
        }
      }
      if (text === raw) text = JSON.stringify(parsed)
    }
  } catch {
    // 不是 JSON 就原样用
  }
  return text.replace(/\s+/g, ' ').slice(0, 160)
}

export function apply(ctx, config) {
  const log = (level, ...args) => {
    try {
      ctx.logger?.[level]?.(...args)
    } catch {
      // 日志永不阻断主流程
    }
  }

  let cfg = normalizeConfig(config)
  let secret = { apiKey: '' }
  let loaded = false

  const ready = (async () => {
    try {
      const saved = await loadConfig(undefined, (error) => {
        log('warn', '[observer] 读取配置失败（将使用默认值）: %s', String(error))
      })
      if (saved !== null && typeof saved === 'object') cfg = normalizeConfig({ ...cfg, ...saved })
      const savedSecret = await loadSecret(undefined, (error) => {
        log('warn', '[observer] 读取密钥失败: %s', String(error))
      })
      if (savedSecret !== null && typeof savedSecret === 'object') secret = { apiKey: typeof savedSecret.apiKey === 'string' ? savedSecret.apiKey : '' }
    } catch (error) {
      log('warn', '[observer] 读取本地配置失败: %s', String(error))
    } finally {
      loaded = true
    }
  })()

  /** @type {Map<string, object>} 每个会话一份观察状态 */
  const sessions = new Map()
  const pendingTimers = new Set()
  const stats = { ticks: 0, narrations: 0, errors: 0, lastError: null, lastNarrationAt: null }

  const MAX_SESSIONS = 40

  function ensureSession(id) {
    let state = sessions.get(id)
    if (state === undefined) {
      // 防止长期运行后 Map 无限增长：淘汰最久没活动的空闲会话
      if (sessions.size >= MAX_SESSIONS) {
        let oldestKey = null
        let oldestAt = Infinity
        for (const [key, value] of sessions) {
          if (value.running || value.busy) continue
          if (value.lastEventAt < oldestAt) {
            oldestAt = value.lastEventAt
            oldestKey = key
          }
        }
        if (oldestKey === null) {
          // 全都在跑时退化为淘汰最久没活动的那个，避免 Map 无界增长
          let fallbackAt = Infinity
          for (const [key, value] of sessions) {
            if (value.lastEventAt < fallbackAt) {
              fallbackAt = value.lastEventAt
              oldestKey = key
            }
          }
        }
        if (oldestKey !== null) sessions.delete(oldestKey)
      }
      state = {
        id,
        entries: [],
        reasoning: '',
        firstEventAt: 0,
        lastEventAt: 0,
        lastNarrationAt: 0,
        lastAttemptAt: 0,
        turnStartedAt: 0,
        failures: 0,
        asking: false,
        lastNarration: null,
        history: [],
        running: false,
        busy: false,
        turn: 0,
        step: 0,
        tokensIn: 0,
        tokensOut: 0,
        error: null,
      }
      sessions.set(id, state)
    }
    return state
  }

  function pushEntry(state, kind, text) {
    if (typeof text !== 'string') return
    const trimmed = text.trim()
    if (trimmed === '') return
    const now = Date.now()
    state.entries.push({ kind, text: trimmed.slice(0, MAX_ENTRY_CHARS), at: now })
    if (state.firstEventAt === 0) state.firstEventAt = now
    state.lastEventAt = now
    while (state.entries.length > MAX_ENTRIES) state.entries.shift()
    let total = 0
    for (const entry of state.entries) total += entry.text.length
    while (total > MAX_TOTAL_CHARS && state.entries.length > 1) {
      total -= state.entries.shift().text.length
    }
  }

  // -------------------------------------------------------------------------
  // 事件采集：只读，不写会话
  // -------------------------------------------------------------------------
  ctx.on(
    'session/event',
    (session, event) => {
      const id = session?.id
      if (typeof id !== 'string' || event === null || typeof event !== 'object') return
      // 子代理会话不观察：主会话里已经能看到 subagent 工具调用
      if (session?.header?.origin === 'subagent') return
      const state = ensureSession(id)
      const data = event.data ?? {}
      switch (event.type) {
        case 'turn/start':
          state.running = true
          state.turnStartedAt = Date.now()
          state.lastEventAt = Date.now()
          state.reasoning = ''
          state.turn = typeof data.turn === 'number' ? data.turn : state.turn
          break
        case 'turn/end': {
          state.running = false
          state.lastEventAt = Date.now()
          if (data.reason === 'error') pushEntry(state, 'result', '（回合异常结束）')
          // 长回合（≥30 秒）结束时补一条收尾播报；短回合不打扰、不烧 token
          const startedAt = state.turnStartedAt
          state.turnStartedAt = 0
          const endedAt = Date.now()
          if (startedAt !== 0 && endedAt - startedAt >= 30000 && endedAt - state.lastNarrationAt >= 15000) {
            const timer = setTimeout(() => {
              pendingTimers.delete(timer)
              void narrate(state)
            }, 1200)
            pendingTimers.add(timer)
          }
          break
        }
        case 'step/start':
          state.step = typeof data.step === 'number' ? data.step : state.step
          state.lastEventAt = Date.now()
          break
        case 'user/message': {
          const text = textOf(data.content)
          if (text !== '') pushEntry(state, 'user', text)
          break
        }
        case 'assistant/message': {
          const message = data.message ?? {}
          const text = textOf(message.content)
          if (text !== '') pushEntry(state, 'assistant', text)
          if (data.interrupted === true) pushEntry(state, 'result', '（本轮被中断）')
          const reasoning = reasoningOf(message.content) || reasoningFromStream(data.stream)
          if (reasoning !== '' && cfg.maxReasoningChars > 0) {
            state.reasoning = `${state.reasoning}\n${reasoning}`.slice(-cfg.maxReasoningChars)
          }
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
                const name = typeof block.name === 'string' ? block.name : 'tool'
                pushEntry(state, 'tool', `${name} ${shortArgs(block.arguments)}`)
              }
            }
          }
          break
        }
        case 'tool/call': {
          const name = typeof data.name === 'string' ? data.name : 'tool'
          pushEntry(state, 'tool', `${name} ${shortArgs(data.arguments)}`)
          break
        }
        case 'tool/result': {
          const message = data.message ?? {}
          const text = textOf(message.content)
          if (text !== '') pushEntry(state, 'result', text.slice(0, 1500))
          if (data.error !== null && data.error !== undefined) {
            const err = data.error
            pushEntry(state, 'result', `工具失败: ${err.name ?? 'error'} ${err.code ?? ''}`.trim())
          }
          break
        }
        default:
          break
      }
    },
    { global: true },
  )

  ctx.on(
    'agent/disposed',
    ({ agent }) => {
      const id = agent?.session?.id
      if (typeof id !== 'string') return
      sessions.delete(id)
    },
    { global: true },
  )

  // -------------------------------------------------------------------------
  // 旁路模型调用
  // -------------------------------------------------------------------------
  function labels() {
    return LABELS[cfg.language] ?? LABELS.zh
  }

  function buildTranscript(state) {
    const label = labels()
    const lines = []
    if (cfg.thinking && cfg.maxReasoningChars > 0 && state.reasoning.trim() !== '') {
      lines.push(`【${label.reasoning}】`)
      lines.push(state.reasoning.trim().slice(-cfg.maxReasoningChars))
      lines.push('')
    }
    lines.push(`【${label.events}】`)
    let budget = cfg.maxTranscriptChars
    const picked = []
    for (let i = state.entries.length - 1; i >= 0 && budget > 0; i -= 1) {
      const entry = state.entries[i]
      const line = `[${label[entry.kind] ?? entry.kind}] ${entry.text}`
      if (line.length > budget) {
        // 保留尾部：工具结果的关键信息通常在末尾
        picked.unshift(line.slice(-budget))
        budget = 0
        break
      }
      picked.unshift(line)
      budget -= line.length
    }
    lines.push(...picked)
    return lines.join('\n')
  }

  async function callProvider({ system, user, maxTokens }) {
    if (cfg.provider === '' || cfg.model === '') throw new Error('尚未选择旁路模型')
    const options = {
      provider: cfg.provider,
      model: cfg.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens,
      temperature: 0.3,
    }
    if (cfg.reasoningEffort !== '') options.reasoningEffort = cfg.reasoningEffort
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
    options.signal = controller.signal
    let text = ''
    let usage = null
    try {
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage
        else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          const aborted = chunk.reason?.kind === 'aborted'
          throw new Error(chunk.reason?.failure?.message ?? (aborted ? '旁路模型调用被中断' : '旁路模型调用失败'))
        }
      }
    } finally {
      clearTimeout(timer)
    }
    return {
      text: text.trim(),
      usage: usage === null
        ? null
        : {
            input:
              (Number(usage.inputTokens ?? usage.input ?? 0) || 0) +
              (Number(usage.cacheReadTokens ?? 0) || 0) +
              (Number(usage.cacheWriteTokens ?? 0) || 0),
            output: Number(usage.outputTokens ?? usage.output ?? 0) || 0,
          },
    }
  }

  async function callCustom({ system, user, maxTokens }) {
    const base = cfg.customBaseUrl.replace(/\/+$/, '')
    if (base === '' || cfg.customModel === '') throw new Error('自定义模式需要填写 URL 与模型 ID')
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret.apiKey !== '' ? { authorization: `Bearer ${secret.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.customModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200)
        throw new Error(`HTTP ${response.status}: ${detail}`)
      }
      const json = await response.json()
      const text = json?.choices?.[0]?.message?.content ?? ''
      const usage = json?.usage
      return {
        text: String(text).trim(),
        usage: usage !== null && typeof usage === 'object'
          ? { input: usage.prompt_tokens, output: usage.completion_tokens }
          : null,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  function callObserver({ system, user, maxTokens }) {
    return cfg.modelMode === 'custom'
      ? callCustom({ system, user, maxTokens })
      : callProvider({ system, user, maxTokens })
  }

  async function narrate(state, { force = false } = {}) {
    if (state.busy || state.asking) return null
    if (!force && !cfg.enabled) return null
    const transcript = buildTranscript(state)
    if (transcript.trim() === '') return null
    state.busy = true
    try {
      const system = cfg.language === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH
      const user = `${transcript}\n\n${cfg.language === 'en' ? 'Report the current progress.' : '请播报当前进度。'}`
      const result = await callObserver({ system, user, maxTokens: 600 })
      if (result.text === '') throw new Error('旁路模型返回了空内容')
      const now = Date.now()
      state.lastNarration = {
        text: result.text,
        at: now,
        turn: state.turn,
        step: state.step,
        usage: result.usage ?? null,
      }
      state.lastNarrationAt = now
      state.history.push(state.lastNarration)
      if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY)
      state.tokensIn += Number(result.usage?.input) || 0
      state.tokensOut += Number(result.usage?.output) || 0
      state.error = null
      state.failures = 0
      stats.narrations += 1
      stats.lastNarrationAt = now
      return state.lastNarration
    } catch (error) {
      state.error = String(error?.message ?? error)
      state.failures += 1
      stats.errors += 1
      stats.lastError = state.error
      log('warn', '[observer] 播报失败: %s', state.error)
      return null
    } finally {
      state.busy = false
    }
  }

  async function ask(state, question) {
    if (state.asking || state.busy) throw new Error('busy')
    state.asking = true
    try {
      const transcript = buildTranscript(state)
      const system = cfg.language === 'en' ? ASK_PROMPT_EN : ASK_PROMPT_ZH
      const user = `${transcript}\n\n${cfg.language === 'en' ? 'Question: ' : '用户的问题：'}${question}`
      const result = await callObserver({ system, user, maxTokens: 800 })
      state.tokensIn += Number(result.usage?.input) || 0
      state.tokensOut += Number(result.usage?.output) || 0
      return result
    } finally {
      state.asking = false
    }
  }

  // -------------------------------------------------------------------------
  // 定时 tick
  // -------------------------------------------------------------------------
  async function tick() {
    if (!loaded) return
    if (!cfg.enabled) return
    // 频率设为「永不」时只保留手动播报
    if (cfg.intervalSeconds === 0) return
    stats.ticks += 1
    const now = Date.now()
    for (const state of sessions.values()) {
      if (state.busy || state.asking) continue
      if (state.entries.length === 0) continue
      const intervalMs = cfg.intervalSeconds * 1000
      const base = state.lastNarrationAt !== 0
        ? intervalMs
        : Math.min(intervalMs, FIRST_DELAY_CAP_SECONDS * 1000)
      const backoff = state.failures === 0
        ? base
        : Math.min(intervalMs, 5000 * 2 ** Math.min(state.failures, 6))
      const anchor = Math.max(state.lastNarrationAt || state.firstEventAt, state.lastAttemptAt)
      if (now - anchor < backoff) continue
      if (state.lastNarrationAt !== 0 && state.lastEventAt <= state.lastNarrationAt) continue
      state.lastAttemptAt = now
      void narrate(state)
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      void tick()
    }, TICK_MS)
    return () => {
      clearInterval(timer)
      for (const pending of pendingTimers) clearTimeout(pending)
      pendingTimers.clear()
    }
  })

  // -------------------------------------------------------------------------
  // HTTP 通道（给浏览器半侧）
  // -------------------------------------------------------------------------
  function publicConfig() {
    return {
      enabled: cfg.enabled,
      overlayEnabled: cfg.overlayEnabled,
      mobileOverlayEnabled: cfg.mobileOverlayEnabled,
      intervalSeconds: cfg.intervalSeconds,
      intervalChoices: [...INTERVAL_CHOICES],
      thinking: cfg.thinking,
      modelMode: cfg.modelMode,
      provider: cfg.provider,
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
      customBaseUrl: cfg.customBaseUrl,
      customModel: cfg.customModel,
      hasApiKey: secret.apiKey !== '',
      maxTranscriptChars: cfg.maxTranscriptChars,
      maxReasoningChars: cfg.maxReasoningChars,
      language: cfg.language,
    }
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let settled = false
      let timer = null
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        fn(value)
      }
      timer = setTimeout(() => {
        finish(reject, new Error('timeout'))
        req.removeAllListeners('data')
        req.resume()
      }, 15000)
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          // 读掉并丢弃剩余数据，保持 socket 可写，让调用方能发出 413
          finish(reject, new Error('body-too-large'))
          req.removeAllListeners('data')
          req.resume()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          finish(resolve, text === '' ? {} : JSON.parse(text))
        } catch (error) {
          finish(reject, error)
        }
      })
      req.on('error', (error) => finish(reject, error))
    })
  }

  function pickSession(want) {
    // 只认调用方指定的会话，绝不回退到「最近活跃会话」：
    // 否则切到一个还没产生事件的新会话 / 新建会话页时，会显示上一个会话的播报。
    if (typeof want !== 'string' || want === '') return null
    return sessions.get(want) ?? null
  }

  ctx.inject(['webServer'], (child) => {
    const webServer = child?.webServer
    if (webServer === undefined || webServer === null) return
    const json = { 'content-type': 'application/json; charset=utf-8' }
    const send = (res, status, body) => {
      if (res.writableEnded || res.destroyed) return
      res.writeHead(status, json)
      res.end(JSON.stringify(body))
    }

    child.effect(() => {
      const routes = []
      const add = (route) => {
        routes.push(webServer.register(route))
      }
      try {
        add({
          kind: 'exact',
          path: '/api/observer/state',
          handler: async (req, res) => {
            if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method-not-allowed' })
            await ready
            const url = new URL(req.url ?? '/', 'http://observer.local')
            const state = pickSession(url.searchParams.get('session') ?? '')
            send(res, 200, {
              ok: true,
              enabled: cfg.enabled,
              session: state?.id ?? null,
              running: state?.running ?? false,
              busy: state?.busy ?? false,
              narration: state?.lastNarration ?? null,
              history: state?.history ?? [],
              tokens: { input: state?.tokensIn ?? 0, output: state?.tokensOut ?? 0 },
              error: state?.error ?? null,
              config: publicConfig(),
              stats: { ...stats },
            })
          },
        }),
        add({
          kind: 'exact',
          path: '/api/observer/config',
          handler: async (req, res) => {
            await ready
            if (req.method === 'GET') return send(res, 200, { ok: true, config: publicConfig() })
            if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' })
            let body
            try {
              body = await readJsonBody(req)
            } catch (error) {
              const big = error?.message === 'body-too-large'
              return send(res, big ? 413 : 400, { ok: false, error: big ? 'payload-too-large' : 'bad-request' })
            }
            const patch = body?.config
            if (patch === null || typeof patch !== 'object') return send(res, 400, { ok: false, error: 'bad-request' })
            const newKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
            if (newKey.length > MAX_API_KEY_CHARS) return send(res, 400, { ok: false, error: 'api-key-too-long' })
            const next = normalizeConfig({ ...cfg, ...patch })
            // 改自定义端点时必须同时提供新 key，否则清掉已存 key：
            // 避免「未鉴权改 URL → 已存密钥被发到新地址」的外泄链。
            const baseChanged = next.customBaseUrl !== cfg.customBaseUrl
            const dropKey = baseChanged && newKey === '' && secret.apiKey !== ''
            let warning = null
            try {
              await saveConfig(next)
            } catch (error) {
              log('warn', '[observer] 保存配置失败: %s', String(error))
              return send(res, 500, { ok: false, error: 'save-failed' })
            }
            cfg = next
            if (newKey !== '') {
              secret = { ...secret, apiKey: newKey }
              try {
                await saveSecret(secret)
              } catch (error) {
                log('warn', '[observer] 保存密钥失败: %s', String(error))
                warning = 'secret-save-failed'
              }
            } else if (body?.clearApiKey === true || dropKey) {
              secret = { ...secret, apiKey: '' }
              try {
                await saveSecret(secret)
              } catch (error) {
                log('warn', '[observer] 清除密钥失败: %s', String(error))
                warning = 'secret-save-failed'
              }
              if (dropKey && warning === null) warning = 'api-key-cleared'
            }
            return send(res, 200, warning === null ? { ok: true, config: publicConfig() } : { ok: true, config: publicConfig(), warning })
          },
        }),
        add({
          kind: 'exact',
          path: '/api/observer/models',
          handler: async (req, res) => {
            if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method-not-allowed' })
            await ready
            const providers = []
            try {
              const listed = ctx.llm.listProviders()
              const settled = await Promise.allSettled(
                listed.map((provider) =>
                  Promise.race([
                    ctx.llm.listModels(provider.id),
                    new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
                  ]),
                ),
              )
              listed.forEach((provider, index) => {
                const result = settled[index]
                const models = result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []
                providers.push({
                  id: provider.id,
                  name: provider.name,
                  models: models.map((model) => ({ id: model.id, name: model.name })),
                })
              })
            } catch (error) {
              log('warn', '[observer] 列出模型失败: %s', String(error))
            }
            send(res, 200, { ok: true, providers })
          },
        }),
        add({
          kind: 'exact',
          path: '/api/observer/model',
          handler: async (req, res) => {
            if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method-not-allowed' })
            await ready
            const url = new URL(req.url ?? '/', 'http://observer.local')
            const provider = url.searchParams.get('provider') ?? ''
            const model = url.searchParams.get('model') ?? ''
            if (provider === '' || model === '') return send(res, 400, { ok: false, error: 'bad-request' })
            try {
              const info = await ctx.llm.resolveModelInfo(provider, model)
              send(res, 200, {
                ok: true,
                model: {
                  id: info.id,
                  name: info.name,
                  reasoning: info.reasoning ?? null,
                },
              })
            } catch (error) {
              send(res, 502, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        add({
          kind: 'exact',
          path: '/api/observer/now',
          handler: async (req, res) => {
            if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' })
            await ready
            let body
            try {
              body = await readJsonBody(req)
            } catch {
              body = {}
            }
            const state = pickSession(body?.session ?? '')
            if (state === null) return send(res, 200, { ok: false, error: 'no-session' })
            if (state.busy) return send(res, 200, { ok: false, error: 'busy' })
            const narration = await narrate(state, { force: true })
            send(res, 200, {
              ok: narration !== null,
              narration,
              history: state.history,
              tokens: { input: state.tokensIn, output: state.tokensOut },
              error: narration === null ? (state.error ?? 'failed') : null,
            })
          },
        }),
        add({
          kind: 'exact',
          path: '/api/observer/ask',
          handler: async (req, res) => {
            if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' })
            await ready
            let body
            try {
              body = await readJsonBody(req)
            } catch {
              return send(res, 400, { ok: false, error: 'bad-request' })
            }
            const question = typeof body?.question === 'string' ? body.question.trim() : ''
            if (question === '') return send(res, 400, { ok: false, error: 'empty-question' })
            if (question.length > MAX_QUESTION_CHARS) return send(res, 400, { ok: false, error: 'question-too-long' })
            const state = pickSession(body?.session ?? '')
            if (state === null) return send(res, 200, { ok: false, error: 'no-session' })
            try {
              const result = await ask(state, question)
              send(res, 200, { ok: true, answer: result.text, usage: result.usage ?? null })
            } catch (error) {
              send(res, 200, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        add({
          kind: 'exact',
          path: '/api/observer/health',
          handler: (req, res) => {
            if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method-not-allowed' })
            send(res, 200, {
              ok: true,
              loaded,
              enabled: cfg.enabled,
              sessions: [...sessions.values()].map((state) => ({
                id: state.id,
                running: state.running,
                entries: state.entries.length,
                lastEventAt: state.lastEventAt,
                lastNarrationAt: state.lastNarrationAt,
                busy: state.busy,
                error: state.error,
              })),
              stats: { ...stats },
            })
          },
        })
      } catch (error) {
        // 中途注册失败：回滚已注册的路由，避免路由表泄漏 + 插件半死
        for (const dispose of routes) {
          try {
            dispose()
          } catch {
            // 回滚失败不影响抛错
          }
        }
        throw error
      }
      return () => {
        for (const dispose of routes) {
          try {
            dispose()
          } catch {
            // 卸载失败不影响插件退出
          }
        }
      }
    })
  })

  // 测试出口：真实宿主里多挂几个方法无副作用
  try {
    ctx.observerStatus = () => ({
      loaded,
      enabled: cfg.enabled,
      config: publicConfig(),
      sessions: [...sessions.values()].map((state) => ({ ...state, entries: state.entries.length })),
      stats: { ...stats },
    })
    ctx.observerNarrate = (sessionId) => {
      const state = sessions.get(sessionId)
      return state === undefined ? null : narrate(state, { force: true })
    }
  } catch {
    // 某些上下文对象可能不可写，忽略
  }
}

export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULTS))
