// src/docParse.ts — 拖入/Read 的 PDF/图片 → GLM-OCR layout_parsing → markdown（与 active provider 解耦）。
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { loadSettings } from './config.js'
import { BUILTIN_PROVIDERS } from './providers.js'
import { GlmKeyMissingError } from './imageDescribe.js'

export interface ParsedDoc { markdown: string; numPages?: number }

const TIMEOUT_MS = 180_000

export class DocParseTimeoutError extends Error {
  constructor() { super('文档解析超时'); this.name = 'DocParseTimeoutError' }
}

export async function parseDocument(
  base64: string, mime: string,
  deps: { fetchImpl?: typeof undiciFetch; apiKey?: string; baseURL?: string } = {},
): Promise<ParsedDoc> {
  const settings = loadSettings()
  const glm = BUILTIN_PROVIDERS.glm
  const key = deps.apiKey ?? process.env[glm.apiKeyEnv] ?? (settings as any).providers?.glm?.apiKey
  if (!key) throw new GlmKeyMissingError()
  const baseURL = deps.baseURL ?? glm.baseURL
  const f = deps.fetchImpl ?? undiciFetch
  const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
  // GLM-OCR file 字段用 data URL（多数 GLM 端点接受）；若真机冒烟发现需原始 base64，改成 file: base64
  let res: any
  try {
    res = await f(`${baseURL}/layout_parsing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'glm-ocr', file: `data:${mime};base64,${base64}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
    } as any)
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new DocParseTimeoutError()
    throw e
  }
  if (!res.ok) throw new Error(`文档解析失败：HTTP ${res.status}`)
  const data: any = await res.json()
  const markdown = data?.md_results
  if (typeof markdown !== 'string') throw new Error('文档解析失败：响应无 md_results')
  return { markdown, numPages: data?.data_info?.num_pages }
}
