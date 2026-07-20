import fs from 'node:fs/promises'
import { parseFrontmatter } from '../agentsLoader.js'
import { scanAllMemories, memoryKey, type MemoryHeader, type MemoryScope } from './memoryScan.js'
import { createFtsDb } from './sqlite.js'

export interface SearchHit {
  key: string
  scope: MemoryScope
  description: string | null
  snippet: string
  score: number
}

const SNIPPET_MAX = 200
const DEFAULT_LIMIT = 8

/** 缓存：签名（文件键+mtime）不变则复用上次装载的行。语料小，重建也毫秒级。 */
let cache: { sig: string; rows: Row[] } | null = null
interface Row { key: string; scope: MemoryScope; description: string | null; body: string }

function signature(dirs: { project: string; global?: string }, heads: MemoryHeader[]): string {
  const dirsKey = `${dirs.project}\0${dirs.global ?? ''}`
  return dirsKey + '||' + heads.map(h => `${memoryKey(h)}@${h.mtimeMs}`).sort().join('|')
}

/** 把任意查询安全化为 FTS5 MATCH 串：抽取字母数字/CJK 词，每个作前缀短语引用，OR 连接。全空返回 null。 */
function toMatchQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}]+/gu)
  if (!terms || !terms.length) return null
  return terms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ')
}

function makeSnippet(body: string, terms: string[]): string {
  let line = body.split('\n').find(l => terms.some(t => l.toLowerCase().includes(t))) ?? ''
  if (!line) line = body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX)
  line = line.replace(/\s+/g, ' ').trim()
  return line.length > SNIPPET_MAX ? line.slice(0, SNIPPET_MAX) + '…' : line
}

async function loadRows(dirs: { project: string; global?: string }): Promise<Row[]> {
  const heads = await scanAllMemories(dirs.project, dirs.global)
  if (!heads.length) { cache = null; return [] }
  const sig = signature(dirs, heads)
  if (cache && cache.sig === sig) return cache.rows
  const rows: Row[] = []
  for (const h of heads) {
    try {
      const raw = await fs.readFile(h.filePath, 'utf8')
      const body = parseFrontmatter(raw).body.trim()
      if (!body) continue
      rows.push({ key: memoryKey(h), scope: h.scope, description: h.description, body })
    } catch { /* 跳过读失败 */ }
  }
  cache = { sig, rows }
  return rows
}

export async function searchMemories(
  dirs: { project: string; global?: string },
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<SearchHit[]> {
  try {
    const match = toMatchQuery(query)
    if (!match) return []
    const rows = await loadRows(dirs)
    if (!rows.length) return []

    const db = await createFtsDb()
    try {
      db.exec('CREATE VIRTUAL TABLE m USING fts5(body, tokenize=\'unicode61\')')
      const ins = db.prepare('INSERT INTO m(rowid, body) VALUES (?, ?)')
      rows.forEach((r, i) => ins.run(i + 1, r.body))
      const found = db.prepare(
        'SELECT rowid, rank FROM m WHERE m MATCH ? ORDER BY rank LIMIT ?',
      ).all(match, limit) as { rowid: number; rank: number }[]
      const terms = (query.match(/[\p{L}\p{N}]+/gu) ?? []).map(t => t.toLowerCase())
      return found.map(f => {
        const r = rows[f.rowid - 1]
        return { key: r.key, scope: r.scope, description: r.description, snippet: makeSnippet(r.body, terms), score: f.rank }
      })
    } finally { db.close() }
  } catch { return [] }
}
