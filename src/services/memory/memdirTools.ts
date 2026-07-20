import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from '../../tools/types.js'
import { assertNotReserved } from '../../memdir/reserved.js'
import { withWriteLock } from './writeLock.js'

/** dream 传入才追加检索工具；不传 = extract fork 形态（只读 memdir，无 MemGrep/MemGlob）。 */
export interface MemToolOpts {
  /** 可读子树（默认 [memdir]，有 globalMemdir 时默认 [memdir, globalMemdir]）。传入即视为 dream 形态。 */
  readRoots?: string[]
  /** 可读的精确文件白名单（本项目会话 transcript）。sessions/ 是全局扁平目录，只能按文件放行。 */
  readFiles?: string[]
  /** 全局记忆抽屉根目录。不传 = 不允许 scope:'global' 写入。 */
  globalMemdir?: string
  /** 写全局记忆时盖的来源项目键（溯源用，供 /memory 展示）。 */
  originKey?: string
}

/** 抢不到全局写锁（或落盘前 guard() 校验发现锁已易主）时的统一提示：放弃本次写，绝不覆盖对方。 */
const GLOBAL_LOCK_SKIP = '提示：全局记忆正被另一个会话写入，本次跳过（避免覆盖对方的更新）。'

const MEMREAD_MAX_CHARS = 100_000
const MEMGREP_LINE_MAX = 300
const MEMGREP_HITS_MAX = 50
const MEMGREP_FILE_MAX = 32 * 1024 * 1024
const MEMGLOB_MAX = 200

/**
 * 返回 null 表示允许；否则返回拒绝原因。target 归一化（含 symlink 解析）后必须在 memdir 子树内。
 * 复用 canon()：symlink 逃逸（memdir 内的软链指向外部文件/目录）会被解析到真实外部路径而拒绝；
 * 尚不存在的新文件/新目录（MemWrite 建新文件的常规场景）不受影响。
 */
export function assertInMemdir(memdir: string, target: string): string | null {
  const root = canon(memdir)
  const abs = canon(target)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return `拒绝：记忆工具只能写入 memory 目录（${root}）内，越界路径 ${path.resolve(target)} 被拦截。`
  }
  return null
}

/**
 * 归一化：`../` 折叠 + symlink 解析。
 * 路径不存在时（如尚未创建的文件）解析最深的存在祖先再拼回剩余段，
 * 否则 /var → /private/var 这类平台 symlink 会让存在与不存在的路径归一化结果不可比。
 */
function canon(p: string): string {
  let cur = path.resolve(p)
  const rest: string[] = []
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest) } catch {}
    const parent = path.dirname(cur)
    if (parent === cur) return path.resolve(p) // 到根仍不存在
    rest.unshift(path.basename(cur))
    cur = parent
  }
}

/** glob → RegExp。`**`/`*` 先换占位符，否则替换插入的 `.*` 会被后续的 `*` 规则再次改写。 */
function globToRegExp(pattern: string): RegExp {
  const GLOBSTAR_SLASH = '\u0000'
  const GLOBSTAR = '\u0001'
  const src = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .split(GLOBSTAR_SLASH).join('(?:.*/)?')
    .split(GLOBSTAR).join('.*')
  return new RegExp('^' + src + '$')
}

/**
 * 读取围栏（安全边界）。返回 null 表示允许。
 * target 归一化后必须落在某个 root 子树内，或精确命中 files 白名单（不是目录前缀）。
 */
export function assertInRoots(roots: string[], files: string[], target: string): string | null {
  const abs = canon(target)
  if (files.some(f => canon(f) === abs)) return null
  for (const r of roots) {
    const root = canon(r)
    if (abs === root || abs.startsWith(root + path.sep)) return null
  }
  return `拒绝：路径 ${path.resolve(target)} 不在本次允许的读取范围内（记忆目录、活动日志、本项目会话）。`
}

/** 递归列出 root 下的普通文件（不跟随 symlink：dirent 的 symlink 既非 dir 也非 file）。 */
function walk(root: string, out: string[]): void {
  let ents: fs.Dirent[]
  try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile()) out.push(p)
  }
}

/** 防回声放大：transcript / 日志里含被注入的记忆全文与系统提示，重新消化会自我循环。 */
function isSystemRoleLine(line: string): boolean {
  return /"role"\s*:\s*"system"/.test(line)
}

/** 逐行标记应跳过的 transcript 行（role:system 行 / <system-reminder> 块，含跨行）。MemRead 与 MemGrep 共用。 */
function markSkippedTranscriptLines(lines: string[]): boolean[] {
  const skip: boolean[] = new Array(lines.length).fill(false)
  let inReminder = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const opens = line.includes('<system-reminder>')
    const closes = line.includes('</system-reminder>')
    if (inReminder) { skip[i] = true; if (closes) inReminder = false; continue }
    if (opens && !closes) { skip[i] = true; inReminder = true; continue }
    if (opens || isSystemRoleLine(line)) skip[i] = true
  }
  return skip
}

/** MemRead 专用：整篇过滤 system 行/<system-reminder> 块，返回过滤后正文与跳过行数（供可见提示）。 */
function filterTranscriptEcho(content: string): { text: string; skipped: number } {
  const lines = content.split('\n')
  const skip = markSkippedTranscriptLines(lines)
  const kept = lines.filter((_, i) => !skip[i])
  return { text: kept.join('\n'), skipped: skip.filter(Boolean).length }
}

/** 不对称保守：拿不准一律 project——放错项目顶多这次没跨过去，放错全局会污染用户所有项目。 */
const SCOPE_DESC = "'global' = 换个项目也成立的、关于用户本人的长期偏好；'project' = 只属于当前项目。**拿不准一律填 project**——放错项目顶多这次没跨过去，放错全局会污染用户所有项目。"

const wschema = z.object({
  file_path: z.string().describe('memory 目录内的相对或绝对路径'),
  content: z.string().describe('完整文件内容（覆盖写）'),
  scope: z.enum(['project', 'global']).default('project').describe(SCOPE_DESC),
})
const eschema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  scope: z.enum(['project', 'global']).default('project').describe(SCOPE_DESC),
})

/**
 * 全局记忆的溯源戳：origin（哪个项目写的）+ created（首次写入日期）。
 * 由代码盖，不由模型写——模型写的元数据不可靠，而 /memory 的纠错展示依赖它。
 * 注意：它不承担任何授权语义（授权边界是物理目录），所以即使内容被投毒伪造也不影响安全。
 */
export function stampGlobalMeta(content: string, origin: string, nowIso: string, existingCreated?: string): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  // 锚到行首顶层（不带 \s*）：否则会误删 block scalar 正文里、或嵌套 key 下缩进的 `origin:`/`created:` 行。
  const strip = (fm: string) => fm.split('\n').filter(l => !/^origin\s*:/.test(l)).join('\n')
  const createdValue = existingCreated ?? nowIso
  if (!m) {
    return `---\norigin: ${origin}\ncreated: ${createdValue}\n---\n${content}`
  }
  const fm = strip(m[1])
  const created = /^created\s*:/m.test(fm) ? '' : `\ncreated: ${createdValue}`
  return `---\n${fm}\norigin: ${origin}${created}\n---\n${content.slice(m[0].length)}`
}

/** 覆盖写前读旧文件的 created 溯源戳（不存在/无 frontmatter/无 created → undefined）。调用方须在锁内调用，防 TOCTOU。 */
function readOldCreated(p: string): string | undefined {
  let old: string
  try { old = fs.readFileSync(p, 'utf8') } catch { return undefined }
  const m = old.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return undefined
  const line = m[1].split('\n').find(l => /^created\s*:/.test(l))
  return line ? line.slice(line.indexOf(':') + 1).trim() : undefined
}
const rschema = z.object({
  file_path: z.string().describe('允许范围内的相对（相对 memory 目录）或绝对路径'),
})
const gschema = z.object({
  pattern: z.string().describe('glob 模式，如 logs/**/*.md'),
})
const grschema = z.object({
  pattern: z.string().describe('正则表达式'),
  path: z.string().optional().describe('限定搜索的子目录（必须在允许范围内）'),
})

export function makeMemdirTools(memdir: string, opts: MemToolOpts = {}): Tool<any>[] {
  const globalMemdir = opts.globalMemdir
  const resolve = (fp: string) => path.isAbsolute(fp) ? fp : path.join(memdir, fp)
  /** 不对称保守：scope 缺失/非法/无全局抽屉 → 一律落项目。 */
  const rootFor = (scope?: string) => (scope === 'global' && globalMemdir) ? globalMemdir : memdir
  const resolveIn = (root: string, fp: string) => path.isAbsolute(fp) ? fp : path.join(root, fp)
  const readRoots = opts.readRoots ?? (globalMemdir ? [memdir, globalMemdir] : [memdir])
  const readFiles = opts.readFiles ?? []
  const searchable = opts.readRoots !== undefined // 只有 dream 传 roots → 才给检索工具

  /** roots ∪ files 内的全部可读文件（去重）。 */
  const candidates = (): string[] => {
    const all: string[] = []
    for (const r of readRoots) walk(r, all)
    for (const f of readFiles) { try { if (fs.statSync(f).isFile()) all.push(f) } catch {} }
    return [...new Set(all.map(p => path.resolve(p)))]
  }

  const memRead: Tool<typeof rschema> = {
    name: 'MemRead',
    description: '读取记忆目录、活动日志或本项目会话文件的内容。只能读允许范围内的路径。',
    inputSchema: rschema,
    isReadOnly: true,
    needsPermission: () => false, // forked 子代理无 UI；隔离靠路径断言
    async call(input) {
      const p = resolve(input.file_path)
      const deny = assertInRoots(readRoots, readFiles, p)
      if (deny) return deny
      const abs = path.resolve(p)
      let content: string
      try { content = fs.readFileSync(abs, 'utf8') }
      catch (e: any) { return `错误：读取失败 ${abs}：${e?.message ?? e}` }
      // 会话 transcript（.jsonl 或命中 readFiles 白名单）过滤系统提示/记忆回声，防 dream 自我强化；
      // 普通记忆 .md 文件不受影响。
      let echoNote = ''
      const cAbs = canon(abs)
      const isTranscript = cAbs.endsWith('.jsonl') || readFiles.some(f => canon(f) === cAbs)
      if (isTranscript) {
        const filtered = filterTranscriptEcho(content)
        content = filtered.text
        if (filtered.skipped) echoNote = `\n[已跳过 ${filtered.skipped} 行系统提示/记忆回声]`
      }
      const body = content.length > MEMREAD_MAX_CHARS
        ? content.slice(0, MEMREAD_MAX_CHARS) + `\n[已截断：文件共 ${content.length} 字符]`
        : content
      return body + echoNote
    },
  }

  const memGlob: Tool<typeof gschema> = {
    name: 'MemGlob',
    description: '在记忆目录与活动日志内按 glob 列出文件（如 logs/**/*.md）。只列允许范围内的文件。',
    inputSchema: gschema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input) {
      let rx: RegExp
      try { rx = globToRegExp(input.pattern) }
      catch { return `错误：无效 glob 模式 ${input.pattern}` }
      const root = canon(memdir)
      const hits = candidates().filter(p => {
        const rel = path.relative(root, canon(p)).split(path.sep).join('/')
        return rx.test(rel) || rx.test(path.basename(p))
      })
      if (!hits.length) return '（无匹配）'
      const shown = hits.slice(0, MEMGLOB_MAX)
      const note = hits.length > MEMGLOB_MAX ? `\n[共 ${hits.length} 个，已截断只显示前 ${MEMGLOB_MAX} 个]` : ''
      return shown.join('\n') + note
    },
  }

  const memGrep: Tool<typeof grschema> = {
    name: 'MemGrep',
    description: '在记忆目录、活动日志与本项目会话 transcript 内按正则检索，返回「文件:行号: 内容」（每行截断，跳过系统提示与 <system-reminder> 块）。',
    inputSchema: grschema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input) {
      let rx: RegExp
      try { rx = new RegExp(input.pattern) } catch { return `错误：无效正则 ${input.pattern}` }
      let targets: string[]
      if (input.path) {
        const p = resolve(input.path)
        const deny = assertInRoots(readRoots, readFiles, p)
        if (deny) return deny
        const base = canon(p) // 与 candidates 同口径比较（canon 会解 /var → /private/var 这类平台 symlink）
        targets = candidates().filter(f => {
          const cf = canon(f)
          return cf === base || cf.startsWith(base + path.sep)
        })
      } else {
        targets = candidates()
      }
      const out: string[] = []
      let skipped = 0
      let capped = false
      for (const f of targets) {
        try { if (fs.statSync(f).size > MEMGREP_FILE_MAX) { skipped++; continue } } catch { continue }
        let content: string
        try { content = fs.readFileSync(f, 'utf8') } catch { continue }
        const lines = content.split('\n')
        const skip = markSkippedTranscriptLines(lines)
        for (let i = 0; i < lines.length && !capped; i++) {
          if (skip[i]) continue
          const line = lines[i]
          if (!rx.test(line)) continue
          out.push(`${f}:${i + 1}: ${line.slice(0, MEMGREP_LINE_MAX)}`)
          if (out.length >= MEMGREP_HITS_MAX) capped = true
        }
        if (capped) break
      }
      const notes = [
        capped ? `[已达 ${MEMGREP_HITS_MAX} 条命中上限，请换更窄的检索词]` : '',
        skipped ? `[${skipped} 个文件超过 ${MEMGREP_FILE_MAX / 1024 / 1024}MB 被跳过]` : '',
      ].filter(Boolean)
      if (!out.length) return notes.length ? '（无匹配）\n' + notes.join('\n') : '（无匹配）'
      return [...out, ...notes].join('\n')
    },
  }

  const memWrite: Tool<typeof wschema> = {
    name: 'MemWrite',
    description: '把整文件写入记忆目录（自动建父目录）。scope 决定写进哪个抽屉：project=只属于当前项目；global=换个项目也成立的长期偏好。',
    inputSchema: wschema,
    isReadOnly: false,
    needsPermission: () => false, // forked 子代理无 UI；隔离靠路径断言
    deniablePaths: (input) => [resolveIn(rootFor(input.scope), input.file_path)],
    async call(input) {
      const scope = input.scope ?? 'project'
      if (scope === 'global' && !globalMemdir) return '错误：当前不允许写入全局记忆。'
      const root = rootFor(scope)
      const p = resolveIn(root, input.file_path)
      const deny = assertInMemdir(root, p)
      if (deny) return deny
      const reserved = assertNotReserved(root, p)
      if (reserved) return reserved

      // 临界区（全局 scope 才套锁）：只包含文件系统读改写，不含任何慢操作。
      // 覆盖写会丢旧 frontmatter，若不在锁内把旧 created 读出来带上，MemWrite 会把它重置成今天
      // （/memory 的溯源展示靠它）；锁外读会有 TOCTOU（读完到写之间被别的进程改写）。
      const doWrite = (): string => {
        const content = (scope === 'global' && opts.originKey)
          ? stampGlobalMeta(input.content, opts.originKey, new Date().toISOString().slice(0, 10), readOldCreated(p))
          : input.content
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true })
          fs.writeFileSync(p, content)
        } catch (e: any) { return `错误：写入失败 ${p}：${e?.message ?? e}` }
        return `已写入 ${p}（${content.length} 字符）。`
      }

      if (scope !== 'global') return doWrite()
      // 落盘前必须 guard() 校验：陈旧锁被两个进程同时夺取时存在微秒级窗口，guard() 为 false 说明锁已易主，弃写。
      const result = await withWriteLock(root, (guard) => (guard() ? doWrite() : null))
      return result === null ? GLOBAL_LOCK_SKIP : result
    },
  }

  const memEdit: Tool<typeof eschema> = {
    name: 'MemEdit',
    description: '在记忆目录内的文件做精确字符串替换。scope 决定改哪个抽屉的文件（同 MemWrite）。',
    inputSchema: eschema,
    isReadOnly: false,
    needsPermission: () => false,
    deniablePaths: (input) => [resolveIn(rootFor(input.scope), input.file_path)],
    async call(input) {
      const scope = input.scope ?? 'project'
      if (scope === 'global' && !globalMemdir) return '错误：当前不允许写入全局记忆。'
      const root = rootFor(scope)
      const p = resolveIn(root, input.file_path)
      const deny = assertInMemdir(root, p)
      if (deny) return deny
      const reserved = assertNotReserved(root, p)
      if (reserved) return reserved

      // 临界区（全局 scope 才套锁）：read → modify → write 全部在这里，防 TOCTOU。
      const doEdit = (): string => {
        let cur: string
        try { cur = fs.readFileSync(p, 'utf8') } catch { return `错误：文件不存在 ${p}` }
        if (!input.old_string) return `错误：old_string 不能为空。`
        const occurrences = cur.split(input.old_string).length - 1
        if (occurrences === 0) return `错误：old_string 未匹配到。`
        if (occurrences > 1) return `错误：old_string 匹配到 ${occurrences} 处，请提供更多上下文使其唯一。`
        try { fs.writeFileSync(p, cur.replace(input.old_string, input.new_string)) }
        catch (e: any) { return `错误：写入失败 ${p}：${e?.message ?? e}` }
        return `已编辑 ${p}。`
      }

      if (scope !== 'global') return doEdit()
      const result = await withWriteLock(root, (guard) => (guard() ? doEdit() : null))
      return result === null ? GLOBAL_LOCK_SKIP : result
    },
  }

  const base: Tool<any>[] = [memRead, memWrite, memEdit]
  return searchable ? [...base, memGlob, memGrep] : base
}
