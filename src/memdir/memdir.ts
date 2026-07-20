import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../agentsLoader.js'
import { isReservedPath } from './reserved.js'

export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25600

const TRUNCATE_SUFFIX = '\n…（索引已截断，用 Read 查看 memory 目录全文）'

/** 按字节边界安全截断 s 到 ≤ maxBytes，丢弃末尾不完整的多字节 UTF-8 序列。 */
function byteSafeSlice(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end-- // 回退到字符起始边界
  return buf.subarray(0, end).toString('utf8')
}

export function truncateEntrypoint(content: string): string {
  let out = content
  let truncated = false
  const lines = out.split('\n')
  if (lines.length > MAX_ENTRYPOINT_LINES) { out = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n'); truncated = true }
  // 预留 suffix 字节预算，保证「正文 + suffix」最终 ≤ 上限，且不裂多字节字符
  if (Buffer.byteLength(out, 'utf8') > MAX_ENTRYPOINT_BYTES) {
    const budget = MAX_ENTRYPOINT_BYTES - Buffer.byteLength(TRUNCATE_SUFFIX, 'utf8')
    out = byteSafeSlice(out, budget)
    truncated = true
  }
  return truncated ? out + TRUNCATE_SUFFIX : out
}

/** 有记忆时追加的查阅指令：把被动的静态索引变成主动查阅（治「不会自动想起」）。 */
const CONSULT_HINT = '\n\n回答用户前，先扫这份索引有无相关条目：有就先用 Read 读该 .md 文件全文、据此再答，不要只凭一行 hook 就作答。索引里没直接看到但你觉得记忆里可能有相关信息时，用 SearchMemory 按关键词搜全文。'

/** 同步收集 memdir 下 mtime > sinceMs 的记忆（排除 MEMORY.md/保留/子目录同 listMdFilesRecursive），
 * 按 mtime 降序取最新 30 条，格式化成「最近」段。fail-safe。 */
function recentTail(memdir: string, sinceMs: number): string {
  const names = listMdFilesRecursive(memdir).filter(f => path.basename(f) !== 'MEMORY.md' && !isReservedPath(f))
  const candidates: { n: string; mtimeMs: number }[] = []
  for (const n of names) {
    try {
      const mtimeMs = fs.statSync(path.join(memdir, n)).mtimeMs
      if (mtimeMs > sinceMs) candidates.push({ n, mtimeMs })
    } catch { /* 跳过 */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const items: string[] = []
  for (const { n } of candidates.slice(0, 30)) {
    try {
      const desc = (parseFrontmatter(fs.readFileSync(path.join(memdir, n), 'utf8')).data as any)?.description
      items.push(`- ${n}: ${typeof desc === 'string' ? desc : '(无描述)'}`)
    } catch { /* 跳过 */ }
  }
  return items.length ? `\n\n## 最近（未归类）\n${items.join('\n')}` : ''
}

/** 读 memdir 注入系统提示的 `## 记忆索引` 段。优先 `.index.md`（主题索引）+ 比它新的记忆尾巴；
 * 无 `.index.md` 时回退 `MEMORY.md`（零回归）。会话启动调一次，保持静态。 */
export function loadMemoryPrompt(memdir: string): string {
  const indexPath = path.join(memdir, '.index.md')
  try {
    const idx = fs.readFileSync(indexPath, 'utf8').trim()
    if (idx) {
      const sinceMs = fs.statSync(indexPath).mtimeMs
      return `## 记忆索引\n${truncateEntrypoint(idx)}${recentTail(memdir, sinceMs)}${CONSULT_HINT}`
    }
  } catch { /* 无 .index.md → 回退 MEMORY.md */ }

  let body = ''
  try { body = fs.readFileSync(path.join(memdir, 'MEMORY.md'), 'utf8').trim() } catch { /* 缺失 */ }
  if (!body) {
    return '## 记忆索引\n（暂无记忆。沉淀的记忆会自动出现在这里；每条记忆是一个带 frontmatter 的 .md 文件，指针记入 MEMORY.md。）'
  }
  return `## 记忆索引\n${truncateEntrypoint(body)}${CONSULT_HINT}`
}

/**
 * 铁律一（取不邀功）：模型看到这些偏好后必须直接照做，不许解释来源。
 * 「它怎么知道的？我好像没说过」才是智能感；「根据我的记忆…」当场把幻觉戳破。
 */
const NO_ATTRIBUTION = '\n\n（以上是你已经知道的、关于这位用户的长期偏好。直接照着做就行——不要在回复里提起这些偏好、不要解释你为什么这么做，更不要说「根据我的记忆」「我记得你说过」之类的话。）'

/**
 * 同步递归收集 dir 下所有 .md 文件相对路径（统一 '/' 分隔，跨平台一致）。
 * 与 memoryScan.scanMemoryFiles 的递归扫描对齐——两者假设不一致是本函数曾经的 bug 根因
 * （子目录里的记忆被 scanMemoryFiles 扫到、却被本函数的非递归 readdir 漏掉，永不注入却无感）。
 * fail-safe：任何一层读失败（目录不存在/权限）直接跳过，不抛。
 * 不用 fs.readdirSync(dir, {recursive:true})：package.json engines 只写 ">=18"，
 * 该选项要 18.17+/20.1+ 才有，不能赌运行环境版本，自己写递归遍历更稳。
 */
function listMdFilesRecursive(dir: string, baseDir: string = dir): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listMdFilesRecursive(full, baseDir))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path.relative(baseDir, full).split(path.sep).join('/'))
  }
  return out
}

/**
 * 全局抽屉 → 系统提示段。全文注入（不是索引）：全局抽屉按设计是稀疏的，
 * 全文注入才能获得与 ~/.deepcode/DEEPCODE.md 同级的确定性（索引式要模型主动 Read，是概率事件）。
 * 超预算才降级为索引清单。会话启动调一次，保持静态（KV 缓存前提）。
 */
export function loadGlobalMemoryPrompt(globalMemdir: string, maxBytes: number): string {
  const names = listMdFilesRecursive(globalMemdir)
    .filter(f => path.basename(f) !== 'MEMORY.md' && !isReservedPath(f))
    .sort()
  if (!names.length) return ''

  const files = names.map(n => {
    try {
      const raw = fs.readFileSync(path.join(globalMemdir, n), 'utf8')
      return { n, body: parseFrontmatter(raw).body.trim() } // frontmatter 是元数据，不进系统提示
    } catch { return null }
  }).filter((f): f is { n: string; body: string } => f !== null && f.body !== '')
  if (!files.length) return ''

  const full = files.map(f => f.body).join('\n\n')
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) {
    return `## 你的长期偏好（跨项目）\n${full}${NO_ATTRIBUTION}`
  }
  let idx = ''
  try { idx = fs.readFileSync(path.join(globalMemdir, '.index.md'), 'utf8').trim() } catch { /* 无 */ }
  if (idx) {
    return `## 你的长期偏好（跨项目）\n条目较多，这里是主题索引；需要时用 SearchMemory 或 MemRead 看全文。\n${truncateEntrypoint(idx)}${NO_ATTRIBUTION}`
  }
  const index = files.map(f => `- ${f.n}`).join('\n')
  return `## 你的长期偏好（跨项目）\n条目较多，这里只列文件名；需要时用 SearchMemory 或 MemRead 读 ${globalMemdir} 下对应文件的全文。\n${index}${NO_ATTRIBUTION}`
}
