// src/session.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ActivityWriter } from './memdir/activityLog.js'

/** newSession 建文件前不知道 file，而 writer 的构造需要从 file 名推导 sessionId——
 *  接线方可传函数形式「拿到 file 再造 writer」；openSession(file) 两种形式都能用。 */
export type ActivityWriterOrFactory = ActivityWriter | ((file: string) => ActivityWriter)

export interface SessionMeta {
  cwd: string
  model: string
  providerId?: string
  thinking: boolean
  effortLevel?: 'low' | 'medium' | 'high'
  permMode: string
  title?: string
}

export interface UsageRecord {
  usage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number }
  model: string
  /** 辅助用量标签：'memory'=记忆/dream fork；'aux'=权限分类器/图片识别等操作性开销。
   *  两者都计入 sessionCost 总额，但排除在主对话的缓存/token 指标之外（主对话=无 kind）。 */
  kind?: 'memory' | 'aux'
}

export interface SessionHandle {
  file: string
  appendMessage(m: any, turn?: number): void
  appendUsage(usage: UsageRecord['usage'], model: string): void
  appendFileState(entries: [string, number][]): void
  appendMeta(meta: SessionMeta): void
  appendCompact(): void
  appendRewind(toTurnId: number): void
  appendTitle(title: string): void
  /** fn 执行期间 appendMessage 不喂 activity writer（历史重放场景，如 compact/rewind 重建）。
   *  未注入 writer 时直接执行 fn，行为与不传 activity 完全一致。 */
  suppressActivity<T>(fn: () => T): T
  /** 往活动日志写一条事件标记（`~ compact`）。未注入 writer 时 no-op。
   *  活动日志绝不影响会话——writer 内部已 fail-safe，这里再兜一层。 */
  appendActivityEvent(text: string): void
}

export interface LoadedSession {
  meta: SessionMeta
  messages: any[]
  usages: UsageRecord[]
  fileState: [string, number][]
  messageTurnIds: (number | undefined)[]
  maxTurnId: number
}

export interface SessionInfo {
  file: string
  mtimeMs: number
  preview: string
}

const DEFAULT_DIR = path.join(os.homedir(), '.deepcode', 'sessions')

function makeHandle(file: string, activityArg?: ActivityWriterOrFactory): SessionHandle {
  let dead = false // 首次写失败后降级为仅内存，避免磁盘问题杀死 REPL
  const activity = typeof activityArg === 'function' ? activityArg(file) : activityArg
  const append = (obj: any) => {
    if (dead) return
    try { fs.appendFileSync(file, JSON.stringify(obj) + '\n') }
    catch (e: any) {
      dead = true
      console.error('[session] 落盘失败，本会话改为仅内存：' + (e?.message ?? e))
    }
  }
  return {
    file,
    appendMessage: (m, turn) => {
      append(turn === undefined ? { t: 'msg', m } : { t: 'msg', m, turn })
      try { activity?.onMessage(m, turn) } catch { /* 活动日志绝不影响会话落盘 */ }
    },
    appendUsage: (usage, model) => append({ t: 'usage', usage, model }),
    appendFileState: entries => append({ t: 'fs', entries }),
    appendMeta: meta => append({ t: 'meta', ...meta }),
    appendCompact: () => append({ t: 'compact' }),
    appendRewind: toTurnId => append({ t: 'rewind', toTurnId }),
    appendTitle: title => append({ t: 'title', title }),
    suppressActivity<T>(fn: () => T): T {
      if (!activity) return fn()
      const prev = activity.suppressed
      activity.suppressed = true
      try { return fn() } finally { activity.suppressed = prev }
    },
    appendActivityEvent: text => {
      try { activity?.event(text) } catch { /* 活动日志绝不影响会话 */ }
    },
  }
}

/** 会话文件路径 → 会话 ID（basename 去 .jsonl）。会话级 hook payload 的 session_id；①b-3 env-file 目录键。 */
export function sessionIdFromFile(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '')
}

/** 新会话：建目录、写 meta 首行、返回句柄。文件名含可读时间戳 + 随机段防碰撞。
 *  activity 可传 writer 本身，或 (file) => writer 工厂——建文件之后才知道 file，
 *  而 writer 的构造往往需要从 file 名推导 sessionId。 */
export function newSession(meta: SessionMeta, dir: string = DEFAULT_DIR, activity?: ActivityWriterOrFactory): SessionHandle {
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = Math.floor(Math.random() * 1e6).toString(36)
  const file = path.join(dir, `${stamp}-${rand}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ t: 'meta', ...meta, createdAt: Date.now() }) + '\n')
  return makeHandle(file, activity)
}

/** 续写已有会话文件（resume 用），不重写 meta。 */
export function openSession(file: string, activity?: ActivityWriterOrFactory): SessionHandle {
  return makeHandle(file, activity)
}

export function loadSession(file: string): LoadedSession {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  let meta: SessionMeta = { cwd: '', model: 'deepseek-v4-pro', thinking: false, permMode: 'default' }
  let sawMeta = false // cwd 是会话身份，只取首条 meta；其余字段后写覆盖
  let messages: any[] = []
  let messageTurnIds: (number | undefined)[] = []
  let maxTurnId = 0
  const usages: UsageRecord[] = []
  let fileState: [string, number][] = []
  for (const line of lines) {
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    if (r.t === 'meta') {
      meta = {
        cwd: sawMeta ? meta.cwd : (r.cwd ?? ''),
        model: r.model ?? 'deepseek-v4-flash',
        providerId: r.providerId,
        thinking: r.thinking ?? false,
        effortLevel: r.effortLevel,
        permMode: r.permMode ?? 'default',
        title: r.title ?? meta.title, // 保留已有 title（meta 行通常不带 title）
      }
      sawMeta = true
    }
    else if (r.t === 'title') { if (typeof r.title === 'string') meta.title = r.title }
    else if (r.t === 'msg') {
      messages.push(r.m)
      messageTurnIds.push(typeof r.turn === 'number' ? r.turn : undefined)
      if (typeof r.turn === 'number' && r.turn > maxTurnId) maxTurnId = r.turn
    }
    else if (r.t === 'usage') usages.push({ usage: r.usage, model: r.model })
    else if (r.t === 'fs') fileState = r.entries // 最后一条覆盖，得到最新快照
    else if (r.t === 'compact') { messages = []; messageTurnIds = [] } // 压缩重置：只清消息，usage/fs 不受影响
    else if (r.t === 'rewind') {
      const cut = messageTurnIds.findIndex(t => t === r.toTurnId)
      if (cut >= 0) { messages = messages.slice(0, cut); messageTurnIds = messageTurnIds.slice(0, cut) }
    }
  }
  const sani = sanitizeDanglingToolCalls(messages, messageTurnIds)
  return { meta, messages: sani.messages, usages, fileState, messageTurnIds: sani.turnIds, maxTurnId }
}

/** 崩溃/截断可能留下没有 tool 结果的 assistant tool_calls，恢复后会被 API 拒收；补合成结果保持可恢复。同步维护 turnIds 对齐。 */
function sanitizeDanglingToolCalls(messages: any[], turnIds: (number | undefined)[]): { messages: any[]; turnIds: (number | undefined)[] } {
  const answered = new Set<string>()
  for (const m of messages) if (m?.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id)
  const out: any[] = []
  const outTurns: (number | undefined)[] = []
  messages.forEach((m, i) => {
    out.push(m); outTurns.push(turnIds[i])
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id && !answered.has(tc.id)) { out.push({ role: 'tool', tool_call_id: tc.id, content: '（中断，无结果）' }); outTurns.push(undefined) }
      }
    }
  })
  return { messages: out, turnIds: outTurns }
}

/** 列出某 cwd 下的会话，新到旧，附首条 user 消息预览。损坏文件跳过。 */
export function listSessions(cwd: string, dir: string = DEFAULT_DIR): SessionInfo[] {
  let files: string[]
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { return [] }
  const out: SessionInfo[] = []
  for (const f of files) {
    const full = path.join(dir, f)
    try {
      const loaded = loadSession(full)
      if (loaded.meta.cwd !== cwd) continue
      const firstUser = loaded.messages.find(m => m.role === 'user')
      const fallback = typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 60) : '(无预览)'
      out.push({
        file: full,
        mtimeMs: fs.statSync(full).mtimeMs,
        preview: loaded.meta.title ?? fallback,
      })
    } catch { continue }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 纯函数：给定 (文件名, mtime) 列表与截止时刻，返回应删除的文件名（mtime < cutoff）。便于单测。 */
export function sessionsToDelete(files: { name: string; mtimeMs: number }[], cutoff: number): string[] {
  return files.filter(f => f.mtimeMs < cutoff).map(f => f.name)
}

/** 清理超龄会话（cleanupPeriodDays 配置项）：删除 mtime 早于 now-maxAgeMs 的 .jsonl。返回删除数。
 *  maxAgeMs ≤ 0 视为不清理。fs 异常不抛（尽力而为，不阻断启动）。 */
export function cleanupOldSessions(maxAgeMs: number, now: number, dir: string = DEFAULT_DIR): number {
  if (!(maxAgeMs > 0)) return 0
  let files: string[]
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { return 0 }
  const withMtime = files.map(name => {
    try { return { name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs } } catch { return null }
  }).filter((x): x is { name: string; mtimeMs: number } => x != null)
  const doomed = sessionsToDelete(withMtime, now - maxAgeMs)
  let n = 0
  for (const name of doomed) {
    try { fs.rmSync(path.join(dir, name)); n++ } catch { /* 尽力而为 */ }
  }
  return n
}

/** 去掉标题尾部的 ` (Branch)` / ` (Branch N)` 后缀，得到基名。 */
export function stripBranchSuffix(title: string): string {
  return title.replace(/\s*\(Branch(?:\s+\d+)?\)$/, '')
}

/** 返回 `${base} (Branch)`，与 existing 碰撞则升级 `(Branch 2/3…)`，取首个未占用名。 */
export function nextBranchTitle(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  let candidate = `${base} (Branch)`
  let n = 2
  while (taken.has(candidate)) { candidate = `${base} (Branch ${n})`; n++ }
  return candidate
}
