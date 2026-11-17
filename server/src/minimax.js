/**
 * MiniMax 对话接口（OpenAI 兼容协议：POST <base>/chat/completions，Bearer Key）。
 *
 * 2026-11 官方文档（platform.minimax.io/docs/guides/text-generation）：
 *   - 国际站 https://api.minimax.io/v1，国内站 https://api.minimaxi.com/v1（见 ai-config.js）；
 *   - M3 系列思考常开，思考过程放在 message.reasoning_content，content 只有最终回答；
 *     reasoning_effort 默认 max —— 分诊不需要那么深，传 medium 省时间省钱；
 *   - 旧模型（M2 系列）可能把思考写成 content 里的 <think>…</think>，这里统一剥掉。
 * 原生错误体是 `{ base_resp: { status_code, status_msg } }`，HTTP 状态却可能是 200，要单独认。
 */
const DEFAULT_TIMEOUT_MS = 90_000

export class MinimaxError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message)
    this.name = 'MinimaxError'
    this.status = status
    this.code = code
  }
}

/** 去掉 <think> 块和 ```json 围栏，取出第一个完整的 JSON 对象 */
export function extractJsonObject(text) {
  const body = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * @param {{ apiKey: string, baseUrl: string, model: string, messages: Array<{role: string, content: string}>,
 *           maxTokens?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ content: string, model: string, usage: object | null, latencyMs: number }>}
 */
export async function minimaxChat(opts) {
  const { apiKey, baseUrl, model, messages, maxTokens = 2000, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  if (!apiKey) throw new MinimaxError('没有配置 MiniMax API Key', { code: 'no_key' })
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
  }
  // reasoning_effort 是 M3 文档里的参数；旧模型不一定认，只给 M3 系列传
  if (/^MiniMax-M3/i.test(model)) body.reasoning_effort = 'medium'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  let res
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    throw new MinimaxError(controller.signal.aborted ? `MiniMax 超过 ${Math.round(timeoutMs / 1000)} 秒没有回应` : `连不上 MiniMax：${error?.message || error}`, { code: 'network' })
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  const baseResp = data?.base_resp
  if (!res.ok || (baseResp && Number(baseResp.status_code) !== 0)) {
    const msg = baseResp?.status_msg || data?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`
    // 1004 / 401：Key 错；1008：余额不足；1002 / 429：限流（MiniMax 错误码表）
    throw new MinimaxError(`MiniMax 返回错误：${msg}`, { status: res.status, code: String(baseResp?.status_code ?? data?.error?.code ?? res.status) })
  }
  const content = String(data?.choices?.[0]?.message?.content ?? '')
  if (!content.trim()) throw new MinimaxError('MiniMax 返回了空内容', { status: res.status, code: 'empty' })
  return {
    content: content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
    model: String(data?.model || model),
    usage: data?.usage ?? null,
    latencyMs: Date.now() - started,
  }
}
