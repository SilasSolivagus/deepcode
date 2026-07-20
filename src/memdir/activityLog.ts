import fs from 'node:fs'
import path from 'node:path'

export const USER_MAX = 4000
export const ASSISTANT_MAX = 1200
export const TOOL_ARG_MAX = 80
export const BASH_ARG_MAX = 120
export const ERR_MAX = 200

/** per-tool 关键参数取值表。Grep 的关键参数是 pattern 而非 path。 */
const ARG_KEY: Record<string, string> = {
  Bash: 'command',
  Edit: 'file_path', Write: 'file_path', Read: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern', Glob: 'pattern',
  Task: 'description', Agent: 'description',
}

export function toolArgSummary(name: string, args: any): string {
  const a = args && typeof args === 'object' ? args : {}
  const key = ARG_KEY[name]
  let v: unknown = key ? a[key] : undefined
  if (typeof v !== 'string') v = Object.values(a).find(x => typeof x === 'string')
  if (typeof v !== 'string') return ''
  let s = v.replace(/\s+/g, ' ').trim()
  if (name === 'Grep' && typeof a.path === 'string' && a.path) s += ` in ${a.path}`
  const max = name === 'Bash' ? BASH_ARG_MAX : TOOL_ARG_MAX
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** ok===undefined（中断合成的 tool 消息）不画符号——历史里看不出成没成，画 ✓ 是撒谎。 */
export function renderToolLine(name: string, args: any, ok: boolean | undefined, content: string): string {
  return renderToolLineFromSummary(name, toolArgSummary(name, args), ok, content)
}

/** 同 renderToolLine，但吃已渲染好的参数摘要——pending 里只存摘要，不钉住整份 args。 */
export function renderToolLineFromSummary(
  name: string, summary: string, ok: boolean | undefined, content: string,
): string {
  const mark = ok === true ? ' ✓' : ok === false ? ' ✗' : ''
  let line = `. ${name}(${summary})${mark}`
  if (ok === false) {
    const err = (content ?? '').replace(/\s+/g, ' ').trim().slice(0, ERR_MAX)
    if (err) line += ` ${err}`
  }
  return line
}

export function stripSystemReminder(s: string): string {
  return s.split('\n\n<system-reminder>')[0]
}

const QUEUED_RE = /^<queued-user-message>\n[^\n]*\n([\s\S]*)\n<\/queued-user-message>$/

/** steering 是用户真说的话（steering.ts:13 包了一层壳）——拆出内层原文。 */
export function unwrapSteering(content: string): string | null {
  const m = QUEUED_RE.exec((content ?? '').trim())
  return m ? m[1] : null
}

/** 用户消息不截断（median 19 字符；超长的正是任务简报）。多行 = 多个 > 行。 */
export function renderUserLines(text: string): string[] {
  let t = stripSystemReminder(text ?? '').trim()
  if (!t) return []
  if (t.length > USER_MAX) t = t.slice(0, USER_MAX) + '…[截断]'
  return t.split('\n').map(l => `> ${l}`)
}

/** 只用于「本轮最后一条不带 tool_calls 的 assistant 消息」= 结论。中途叙述整行丢弃。 */
export function renderAssistantLine(content: string): string | null {
  let t = (content ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (t.length > ASSISTANT_MAX) t = t.slice(0, ASSISTANT_MAX) + '…'
  return `< ${t}`
}

export function slugify(s: string): string {
  const clean = (s ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|.\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean ? clean.slice(0, 40).replace(/-+$/, '') : 'untitled'
}

const p2 = (n: number) => String(n).padStart(2, '0')

export function activityLogPath(memdir: string, when: Date, sessionId: string, slug: string): string {
  return path.join(
    memdir, 'logs',
    String(when.getFullYear()), p2(when.getMonth() + 1), p2(when.getDate()),
    `${sessionId}-${slug}.md`,
  )
}

/** session.ts:80 newSession 把 ISO 时间戳的 `:` `.` 换成 `-` 再拼 `-<随机段>`，
 *  形如 `2026-07-13T03-26-29-006Z-2vmb`。这里原样反解出创建时刻，供活动日志按会话真实
 *  起始日期归档（而非按写入时的 now()）——resume 场景两者会跨天错开。
 *  解析不出来（旧测试的 'sess-1' 这类 id、或格式不认识）返回 null，调用方回退 now()，绝不抛。 */
const SESSION_ID_STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-z]+$/

export function sessionStartedAt(sessionId: string): Date | null {
  const m = SESSION_ID_STAMP_RE.exec(sessionId ?? '')
  if (!m) return null
  const [, date, hh, mm, ss, ms] = m
  const d = new Date(`${date}T${hh}:${mm}:${ss}.${ms}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 兜底：sessionId 精确前缀匹配，在 `<memdir>/logs/` 下递归找是否已存在该会话的日志文件。
 *  即使修 1/修 2 到位，接线方忘了传 slug 仍可能分片——找到就复用，避免同会话写进两个文件。
 *  找不到 / 目录不存在 / 任何 IO 异常一律按“没找到”处理，绝不抛。 */
function findExistingLogFile(memdir: string, sessionId: string): string | null {
  const prefix = `${sessionId}-`
  const walk = (dir: string): string | null => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        const found = walk(full)
        if (found) return found
      }
      else if (e.isFile() && e.name.startsWith(prefix) && e.name.endsWith('.md')) return full
    }
    return null
  }
  try { return walk(path.join(memdir, 'logs')) } catch { return null }
}

const BANG_RE = /^<bash-input>([\s\S]*?)<\/bash-input>/

export interface ActivityWriter {
  /** 会话消息入口。turn 有值 = 真实用户话轮（fail-closed 判别的唯一依据）。 */
  onMessage(m: any, turn?: number): void
  /** 事件标记行（`~ compact` / `~ 中断`）。文件尚未创建时静默丢弃，不为事件单独建文件。 */
  event(text: string): void
  /** 置真时一切写入静默丢弃（compact / fork / background 的历史重放）。 */
  suppressed: boolean
}

export interface ActivityWriterOpts {
  /** 懒求值：/cd 之后 memdir 可能变。 */
  memdir: () => string
  sessionId: string
  meta: { cwd: string; model: string; parent?: string }
  /** mem.enabled && !memoryPaused，每次 onMessage 查一次（不能构造时快照）。 */
  enabled: () => boolean
  /** 工具成败：来自 loop.ts 的 WeakMap 侧信道。undefined = 看不出成没成。 */
  toolOk?: (m: any) => boolean | undefined
  /** 工具是否只读（只读且非失败的调用不写）。 */
  isReadOnly?: (name: string) => boolean
  now?: () => Date
  /** 日志文件名里的标题片段。不传则从 writer 看到的首条消息推导。
   *  resume 时必须由接线方传入（否则新 writer 会用「新说的话」推出不同的 slug，
   *  导致同一会话被写进两个文件）。 */
  slug?: string
  /** 用户消息在日志里的展示文本覆盖（侧信道）。
   *  用于斜杠命令等「喂模型的 userText ≠ 用户说的话」的路径。
   *
   *  语义（`?? content` 只对 nullish 回退）：
   *  - 返回 `undefined` → 退回 `m.content`（"这条我不管"）；
   *  - 返回 `''`（空串）→ **丢弃该行**：不写 `>` 行，且若文件尚未创建则连文件都不建。
   *    "没匹配上"要返回 `undefined`，不要返回空串。 */
  displayText?: (m: any) => string | undefined
}

/** pending 上限：病态会话（模型狂发 tool_calls 却无结果）不许把内存吃穿。超出丢最老的。 */
const PENDING_MAX = 200

/**
 * 有状态的活动日志 writer：懒创建文件、暂存工具调用等结果到达再写、连续同行折叠。
 * **fail-safe 是硬不变量**：任何 IO 失败或宿主回调抛出都只能吞掉并自锁（dead），绝不抛给会话。
 */
export function createActivityWriter(o: ActivityWriterOpts): ActivityWriter {
  const now = o.now ?? (() => new Date())
  /** 只存渲染好的参数摘要（≤120 字符），不存原始 args——否则一个 Write 的整份文件正文会被钉到会话结束。 */
  const pending = new Map<string, { name: string; summary: string }>()
  let file: string | null = null
  /** 独立 dead 标志，与 SessionHandle 的 dead 互不影响。 */
  let dead = false
  /** 自维护的已写字节数（不靠 statSync，见 fold）。 */
  let size = 0
  /** 折叠状态：仅工具行参与。offset/bytes 为字节量，供回写 ×N 时定位覆写。 */
  let fold: { line: string; count: number; offset: number; bytes: number } | null = null

  /** 每行一次写系统调用；行已硬截断，O_APPEND 下不撕行。 */
  const writeLine = (line: string): void => {
    if (dead || !file) return
    const foldable = line.startsWith('. ')

    if (fold && foldable && fold.line === line) {
      // 先确认文件尾就是我们上次写的那一行——若被外部改动（尺寸对不上）则放弃折叠、
      // 退化为普通追加，绝不拿错误的偏移去覆写别人追加的字节。
      let intact = false
      try { intact = fs.statSync(file).size === fold.offset + fold.bytes } catch { intact = false }
      if (intact) {
        // 折叠行长度单调不减（`. X\n`(17) → `. X ×2\n`(21) → `×3\n`(21) → `×10\n`(22)…），
        // 所以在 fold.offset 定位覆写即可，**不需要 truncate**。
        // 「先 truncate 后 append」有数据丢失窗口：append 一旦失败（ENOSPC/EIO），
        // 那条已经成功落盘的工具行就被永久抹掉了。
        const buf = Buffer.from(`${line} ×${fold.count + 1}\n`)
        try {
          const fd = fs.openSync(file, 'r+')
          try { fs.writeSync(fd, buf, 0, buf.length, fold.offset) }
          finally { fs.closeSync(fd) }
        } catch { dead = true; return }
        fold.count++
        fold.bytes = buf.length
        size = fold.offset + buf.length
        return
      }
      try { size = fs.statSync(file).size } catch { dead = true; return }
    }

    const rendered = line + '\n'
    try { fs.appendFileSync(file, rendered) } catch { dead = true; return }
    const n = Buffer.byteLength(rendered)
    fold = foldable ? { line, count: 1, offset: size, bytes: n } : null
    size += n
  }

  const ensureFile = (slugSource: string): boolean => {
    if (file) return true
    if (dead) return false
    try {
      const memdir = o.memdir()
      // 兜底先行：同 sessionId 已有日志文件就直接复用（跳过 frontmatter，已经写过了）。
      // 只在 file === null 时跑，每个 writer 实例最多一次，成本可忽略。
      const existingLog = findExistingLogFile(memdir, o.sessionId)
      if (existingLog) {
        const existingSize = fs.statSync(existingLog).size
        // 0 字节视为“没找到”：上次 writeFileSync(p, fm, {flag:'a'}) 可能在 open 成功、
        // write 之前进程被杀，留下空文件——复用它会导致 frontmatter 永久缺失，不如新建。
        if (existingSize > 0) {
          // 复用前确认结尾是换行符：appendFileSync 在 ENOSPC 下可能部分写入后抛出，
          // 留下半截行——不补的话，下面追加的新行会拼到那行尾巴上。
          const fd = fs.openSync(existingLog, 'r')
          const lastByte = Buffer.alloc(1)
          try { fs.readSync(fd, lastByte, 0, 1, existingSize - 1) }
          finally { fs.closeSync(fd) }
          size = existingSize
          if (lastByte[0] !== 0x0a) { fs.appendFileSync(existingLog, '\n'); size += 1 }
          file = existingLog
          return true
        }
      }
      const when = sessionStartedAt(o.sessionId) ?? now()
      const p = activityLogPath(memdir, when, o.sessionId, slugify(o.slug ?? slugSource))
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const fm = [
        '---',
        `session: ${o.sessionId}`,
        `cwd: ${o.meta.cwd}`,
        `model: ${o.meta.model}`,
        `started: ${when.toISOString()}`,
        ...(o.meta.parent ? [`parent: ${o.meta.parent}`] : []),
        '---',
        '',
      ].join('\n')
      // resume 会为同一 sessionId 新建 writer 实例并算出同一路径——文件已有内容就直接接着追加，
      // 不能在正文中间再插一份 frontmatter。
      let existing = 0
      try { existing = fs.statSync(p).size } catch { existing = 0 }
      if (existing === 0) fs.writeFileSync(p, fm, { flag: 'a' })
      size = fs.statSync(p).size
      file = p
      return true
    } catch { dead = true; return false }
  }

  const live = (): boolean => !w.suppressed && !dead && o.enabled()

  const onMessageInner = (m: any, turn?: number): void => {
    if (!m || typeof m !== 'object') return
    const role = m.role

    // pending 簿记要在门控**之外**做：tool_calls 落在 enabled 里、结果落在 enabled=false /
    // suppressed 里（/pause-memory、compact 重放边界）时，entry 否则永不删除 → 泄漏。
    let call: { name: string; summary: string } | undefined
    if (role === 'tool' && m.tool_call_id) {
      call = pending.get(m.tool_call_id)
      if (call) pending.delete(m.tool_call_id)
    }

    if (!live()) return

    if (role === 'system') return

    if (role === 'user') {
      const content = typeof m.content === 'string' ? m.content : ''
      const steered = unwrapSteering(content)
      let text: string
      if (turn !== undefined) text = o.displayText?.(m) ?? content // 真实用户话轮（唯一两个入口都带 turnId）
      else if (steered !== null) text = steered                 // steering：拆出内层原文
      else if (content.startsWith('<bash-input>')) {            // bang：记成工具行，不当用户话轮
        const cmd = (BANG_RE.exec(content)?.[1] ?? '').replace(/\s+/g, ' ').trim()
        if (!ensureFile(cmd || 'bang')) return
        writeLine(`. !${cmd.slice(0, BASH_ARG_MAX)}`)
        return
      }
      else return                                               // 12 处合成注入 + git-context：fail-closed 默认跳过
      if (!text.trim()) return
      const lines = renderUserLines(text)
      if (!lines.length) return
      if (!ensureFile(stripSystemReminder(text).trim())) return
      for (const l of lines) writeLine(l)
      return
    }

    if (role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          const id = tc?.id
          if (!id) continue
          let args: any = {}
          try { args = JSON.parse(tc?.function?.arguments ?? '{}') } catch { /* 坏 JSON：留空参数 */ }
          const name = tc?.function?.name ?? '?'
          if (!pending.has(id) && pending.size >= PENDING_MAX) {
            const oldest = pending.keys().next().value          // Map 保序：首个 = 最老
            if (oldest !== undefined) pending.delete(oldest)
          }
          pending.set(id, { name, summary: toolArgSummary(name, args) })
        }
        return                                                  // 中途叙述整行丢弃（median 33 字符，零信息）
      }
      if (!file) return                                         // 还没有用户消息 → 不为助手单独建文件
      const line = renderAssistantLine(typeof m.content === 'string' ? m.content : '')
      if (line) writeLine(line)
      return
    }

    if (role === 'tool') {
      if (!call) return                                         // 孤儿 / 已被清理
      if (!file) return
      const ok = o.toolOk?.(m)
      const ro = o.isReadOnly?.(call.name) ?? false
      if (ro && ok !== false) return                            // 只读且非失败 → 不写（占全部调用 60.4%）
      writeLine(renderToolLineFromSummary(call.name, call.summary, ok, typeof m.content === 'string' ? m.content : ''))
    }
  }

  // fail-safe 是硬不变量：函数体整体包 try/catch。宿主传进来的回调（enabled / displayText /
  // toolOk / isReadOnly）都在会话的消息落盘路径上被调用，任一处 TypeError 都不许炸上去。
  const w: ActivityWriter = {
    suppressed: false,

    event(text: string) {
      try {
        if (!live() || !file) return
        const t = (text ?? '').replace(/\s+/g, ' ').trim()
        if (t) writeLine(`~ ${t}`)
      } catch { dead = true }
    },

    onMessage(m: any, turn?: number) {
      try { onMessageInner(m, turn) } catch { dead = true }
    },
  }

  return w
}
