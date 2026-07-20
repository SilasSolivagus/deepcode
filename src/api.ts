import OpenAI from 'openai'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { loadSettings } from './config.js'
import { resolveActiveProvider, activeProvider, activeModelMeta, legacyGlobalKeyApplies, type Dialect } from './providers.js'

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens: number
}

export interface ToolCall { id: string; name: string; args: string }

export interface ChatResult {
  content: string
  toolCalls: ToolCall[]
  usage: Usage
  finishReason: string
}

// 流式分片拼装器。DeepSeek（OpenAI 兼容）的 tool_calls 按 index 分片到达：
// id/name 在首个分片，arguments 是后续分片的字符串增量，必须按 index 聚合。
export class Assembler {
  private content = ''
  private finishReason = ''
  private usage: Usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  private calls = new Map<number, { id: string; name: string; args: string }>()

  constructor(private dialect: Dialect = 'deepseek') {}

  /** 喂入一个流式分片，返回其中的文本增量 */
  push(chunk: any): { text: string; reasoning: string } {
    if (chunk?.usage) {
      const u = chunk.usage
      const cacheHit =
        this.dialect === 'glm' ? (u.prompt_tokens_details?.cached_tokens ?? 0)
        : this.dialect === 'openai' ? 0
        : (u.prompt_cache_hit_tokens ?? 0)
      this.usage = {
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        prompt_cache_hit_tokens: cacheHit,
      }
    }
    const choice = chunk?.choices?.[0]
    if (!choice) return { text: '', reasoning: '' }
    if (choice.finish_reason) this.finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    for (const tc of delta.tool_calls ?? []) {
      const slot = this.calls.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      this.calls.set(tc.index, slot)
    }
    // reasoning_content（thinking 模式的思考流）只用于显示，不进 content/messages
    const text: string = delta.content ?? ''
    this.content += text
    return { text, reasoning: delta.reasoning_content ?? '' }
  }

  finish(): ChatResult {
    return {
      content: this.content,
      toolCalls: [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c),
      usage: this.usage,
      finishReason: this.finishReason,
    }
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'])

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const retryable =
        RETRYABLE_STATUS.has(err?.status) ||
        RETRYABLE_CODES.has(err?.code) ||
        err?.name === 'APIConnectionError'
      if (attempt >= maxRetries || !retryable) throw err
      await sleep(1000 * 2 ** attempt)
    }
  }
}

export function createClient(flagSettingsPath?: string): OpenAI {
  const settings = loadSettings(process.cwd(), flagSettingsPath)
  const preset = resolveActiveProvider(settings)
  const providerKey = (settings.providers as any)?.[preset.id]?.apiKey
  // 全局 settings.apiKey 归属 deepseek（向导写的）与 custom（用户自建端点）。绝不拿它当别的内置厂商的 key——
  // 否则 provider 被改成 glm 而没配 key 时，会把 DeepSeek 的密钥发到智谱的端点（凭证外泄）。
  const legacyKey = legacyGlobalKeyApplies(preset) ? settings.apiKey : undefined
  const apiKey = process.env[preset.apiKeyEnv] ?? providerKey ?? legacyKey
  if (!apiKey) {
    throw new Error(`缺少 ${preset.id} API key。设置环境变量 ${preset.apiKeyEnv}=...，或在 ~/.deepcode/settings.json 的 providers.${preset.id}.apiKey 配置`)
  }
  // Node fetch 不读代理环境变量；显式接入，否则需走代理的网络环境下请求会超时
  const proxy =
    process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
  const baseURL = settings.baseURL ?? preset.baseURL
  return new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 0, // 重试统一由 withRetry 负责，避免与 SDK 自带重试叠加
    // dispatcher 必须配同一 undici 包的 fetch，混用 Node 内置 fetch 会 InvalidArgumentError
    ...(proxy ? { fetch: undiciFetch as any, fetchOptions: { dispatcher: new ProxyAgent(proxy) } as any } : {}),
  })
}

export interface ChatOptions {
  model: string
  messages: any[]
  tools: any[]
  thinking: boolean
  effortLevel?: 'low' | 'medium' | 'high'
  signal: AbortSignal
  dialect?: Dialect
  supportsThinking?: boolean
  supportsVision?: boolean
}

/** 拼线：带 images 旁挂的 user 消息，视觉模型下就地拼成 OpenAI 内容块（文本块在前、image_url 随后）；
 *  否则退化为字符串 content。任一情况都剥掉内部 images 字段（OpenAI SDK 不识别）。 */
export function toWireMessages(messages: any[], supportsVision: boolean): any[] {
  return (messages ?? []).map(m => {
    if (m?.images?.length && supportsVision) {
      const blocks = [
        { type: 'text', text: m.content },
        ...m.images.map((im: { base64: string; mime: string }) => ({
          type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` },
        })),
      ]
      return { ...m, content: blocks, images: undefined }
    }
    if (m?.images) return { ...m, images: undefined }
    return m
  })
}

/** thinking 请求体三态：supportsThinking=false → 完全省略；true → 按开关 enabled/disabled。 */
export function buildThinkingParams(
  supportsThinking: boolean,
  thinking: boolean,
  effortLevel: 'low' | 'medium' | 'high' | undefined,
): Record<string, unknown> {
  if (!supportsThinking) return {}
  return thinking
    ? { reasoning_effort: effortLevel ?? 'medium', thinking: { type: 'enabled' } }
    : { thinking: { type: 'disabled' } }
}

export type StreamDelta = { type: 'text' | 'reasoning'; delta: string }

export async function* chatStream(client: OpenAI, opts: ChatOptions): AsyncGenerator<StreamDelta, ChatResult> {
  const dialect = opts.dialect ?? activeProvider().dialect
  const supportsThinking = opts.supportsThinking ?? activeModelMeta(opts.model).supportsThinking
  const supportsVision = opts.supportsVision ?? (activeModelMeta(opts.model).supportsVision ?? false)
  const wireMessages = toWireMessages(opts.messages, supportsVision)
  // 重试只覆盖"建立流"；分片开始到达后中断则直接抛出
  const stream = await withRetry(() =>
    client.chat.completions.create(
      {
        model: opts.model,
        messages: wireMessages,
        ...(opts.tools.length ? { tools: opts.tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...buildThinkingParams(supportsThinking, opts.thinking, opts.effortLevel),
      } as any,
      { signal: opts.signal },
    ),
  )
  const asm = new Assembler(dialect)
  for await (const chunk of stream as any) {
    const { text, reasoning } = asm.push(chunk)
    if (reasoning) yield { type: 'reasoning', delta: reasoning }
    if (text) yield { type: 'text', delta: text }
  }
  return asm.finish()
}
