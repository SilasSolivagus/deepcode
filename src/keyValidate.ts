// src/keyValidate.ts — 首跑向导「贴 key 就测」当场验证器：三种最小请求，独立 15s 超时，绝不抛。
import OpenAI from 'openai'
import { bochaSearch, tavilySearch, type FetchJson } from './webSearch.js'
import { BUILTIN_PROVIDERS } from './providers.js'

export type ValidateResult = { ok: true } | { ok: false; error: string }
export type LlmSpec = { apiKeyEnvOrKey: string; baseURL: string; model: string }

const TIMEOUT_MS = 15_000

/** 401/403/invalid_api_key（OpenAI SDK 的 err.status，或 webSearch 单源函数抛的 "HTTP 401 ..." 纯文本）→ 无效；
 *  其余（网络不通/超时/未知）统一归为网络类提示。 */
function classifyError(err: any): string {
  const httpStatusInMessage = typeof err?.message === 'string' ? err.message.match(/\bHTTP (\d{3})\b/) : null
  const status = err?.status ?? (httpStatusInMessage ? Number(httpStatusInMessage[1]) : undefined)
  if (status === 401 || status === 403 || err?.code === 'invalid_api_key') return 'API key 无效或无权限'
  return '网络不通或超时'
}

/** 用 baseURL+key 发一个最小 LLM 请求验证 key 有效性。 */
export async function validateLlmKey(spec: LlmSpec, deps: { client?: OpenAI } = {}): Promise<ValidateResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const client = deps.client ?? new OpenAI({ apiKey: spec.apiKeyEnvOrKey, baseURL: spec.baseURL, maxRetries: 0 })
    await client.chat.completions.create(
      { model: spec.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 } as any,
      { signal: ac.signal },
    )
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: classifyError(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** Bocha/Tavily 各发一个最小查询验证 key 有效性（复用 webSearch.ts 的单源函数）。 */
export async function validateSearchKey(
  source: 'bocha' | 'tavily',
  key: string,
  deps: { fetchJson?: FetchJson } = {},
): Promise<ValidateResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const search = source === 'bocha' ? bochaSearch : tavilySearch
    await search(key, 'test', { count: 1, signal: ac.signal }, deps.fetchJson)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: classifyError(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** 用 GLM key 发一个最小 chat 验证 key 有效性（免费的 glm-4.6v-flash 档，不必真发图）。 */
export async function validateVisionKey(glmKey: string, deps: { client?: OpenAI } = {}): Promise<ValidateResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const client = deps.client ?? new OpenAI({ apiKey: glmKey, baseURL: BUILTIN_PROVIDERS.glm.baseURL, maxRetries: 0 })
    await client.chat.completions.create(
      { model: 'glm-4.6v-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 } as any,
      { signal: ac.signal },
    )
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: classifyError(err) }
  } finally {
    clearTimeout(timer)
  }
}
