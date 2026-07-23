// src/webSearch.ts —— WebSearch 双源（Bocha+Tavily）provider + 合并去重。
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { VERSION } from './version.js'

export interface WebSearchResult { title: string; url: string; snippet: string }
export interface WebSearchOpts { allowedDomains?: string[]; blockedDomains?: string[]; count?: number; signal?: AbortSignal }
export type FetchJson = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<any>

/** undici + ProxyAgent（本机必走代理），镜像 webfetch.ts。非 2xx 抛错。 */
export const defaultFetchJson: FetchJson = async (url, init) => {
  const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
  const res = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
  } as any)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return res.json()
}

export async function bochaSearch(
  apiKey: string,
  query: string,
  opts: WebSearchOpts,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<WebSearchResult[]> {
  const json = await fetchJson('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, count: opts.count ?? 5, freshness: 'noLimit' }),
    signal: opts.signal,
  })
  const value: any[] = json?.data?.webPages?.value ?? []
  return value
    .map(v => ({ title: String(v?.name ?? ''), url: String(v?.url ?? ''), snippet: String(v?.snippet ?? '') }))
    .filter(r => r.url)
}

export async function tavilySearch(
  apiKey: string,
  query: string,
  opts: WebSearchOpts,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<WebSearchResult[]> {
  const body: Record<string, unknown> = { query, max_results: opts.count ?? 5 }
  if (opts.allowedDomains?.length) body.include_domains = opts.allowedDomains
  if (opts.blockedDomains?.length) body.exclude_domains = opts.blockedDomains
  const json = await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  const results: any[] = json?.results ?? []
  return results
    .map(r => ({ title: String(r?.title ?? ''), url: String(r?.url ?? ''), snippet: String(r?.content ?? '') }))
    .filter(r => r.url)
}

export const MAX_MERGED_RESULTS = 8
export const MAX_SNIPPET_CHARS = 200

export function normalizeUrl(u: string): string {
  try {
    const p = new URL(u)
    p.hash = ''
    let s = `${p.protocol}//${p.host.toLowerCase()}${p.pathname}${p.search}`
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s
  } catch {
    return u
  }
}

/** round-robin 交错各源 → 按 normalizeUrl 去重（首次胜）→ 截 cap → snippet 截断。 */
export function mergeResults(lists: WebSearchResult[][], cap: number = MAX_MERGED_RESULTS): WebSearchResult[] {
  const seen = new Set<string>()
  const out: WebSearchResult[] = []
  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0)
  for (let i = 0; i < maxLen && out.length < cap; i++) {
    for (const list of lists) {
      if (out.length >= cap) break
      const r = list[i]
      if (!r) continue
      const key = normalizeUrl(r.url)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...r, snippet: r.snippet.length > MAX_SNIPPET_CHARS ? r.snippet.slice(0, MAX_SNIPPET_CHARS) + '…' : r.snippet })
    }
  }
  return out
}

// —— anysearch：匿名 fallback（无 Bocha/Tavily key 时用）——

export const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/mcp'
export const ANYSEARCH_CLIENT = `deepcode/${VERSION}` // 实测服务器不 gate，用自己标识不抄 skill/3.0.1
export const MAX_ANYSEARCH_RAW = 2000
export class AnysearchError extends Error {}

/** 剥 markdown/导航 cruft：去图片、[text](url)→text、去 markdown 记号、折叠空白。 */
function stripCruft(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`>|_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 结构化解析 anysearch 的 markdown 文本块。只锚带编号标题（### N. …），
 *  snippet = URL 行之后到下一个编号标题（含假 ### 子标题，剥 cruft 即可）。无 URL 块丢弃。 */
export function parseAnysearchResults(text: string): WebSearchResult[] {
  if (typeof text !== 'string' || !text) return []
  const headRe = /^###\s+\d+\.\s+(.*)$/gm
  const heads: { title: string; end: number; start: number }[] = []
  let m: RegExpExecArray | null
  while ((m = headRe.exec(text))) heads.push({ title: m[1].trim(), start: m.index, end: headRe.lastIndex })
  const out: WebSearchResult[] = []
  for (let i = 0; i < heads.length; i++) {
    const block = text.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].start : text.length)
    const urlM = block.match(/^-\s+\*\*URL\*\*:\s*(\S+)/m)
    if (!urlM) continue
    const url = urlM[1].trim()
    const afterUrl = block.slice((urlM.index ?? 0) + urlM[0].length, (urlM.index ?? 0) + urlM[0].length + MAX_ANYSEARCH_RAW)
    let snippet = stripCruft(afterUrl)
    if (snippet.length > MAX_SNIPPET_CHARS) snippet = snippet.slice(0, MAX_SNIPPET_CHARS) + '…'
    out.push({ title: heads[i].title, url, snippet })
  }
  return out.filter(r => r.url)
}

export async function anysearchSearch(
  query: string, opts: WebSearchOpts, apiKey: string | undefined,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<WebSearchResult[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Anysearch-Client': ANYSEARCH_CLIENT }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const signals: AbortSignal[] = [AbortSignal.timeout(10_000)]
  if (opts.signal) signals.push(opts.signal)
  const json = await fetchJson(ANYSEARCH_ENDPOINT, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query, max_results: opts.count ?? 5 } } }),
    signal: AbortSignal.any(signals),
  })
  if (json?.error) throw new AnysearchError(String(json.error?.message ?? 'anysearch error'))
  const text = json?.result?.content?.[0]?.text
  return parseAnysearchResults(typeof text === 'string' ? text : '')
}
