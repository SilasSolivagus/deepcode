// src/fleet.ts
// 7.4 FleetView 域逻辑：三源（后台会话/后台任务/工作流）归一为 FleetJob + 分组/排序/fold/tempo。
// 纯函数，无 TUI 依赖，不调 Date.now()/Math.random()（now 参数注入）。
import path from 'node:path'
import type { JobState } from './backgroundSession.js'
import type { BackgroundTask } from './tasks.js'
import type { WorkflowRunSummary } from './tui/WorkflowView.js'

export type FleetBand = 'working' | 'done'          // done 含所有终态，靠 status 色分
export type FleetStatus = 'success' | 'failed' | 'stopped'
export type FleetTempo = 'flowing' | 'slowing' | 'stuck'
export type FleetKind = 'session' | 'task' | 'workflow'
export type FleetBackend = 'detached' | 'local'
export type FleetGroupMode = 'state' | 'cwd'

export const PEAK_CONCURRENT_GOAL = 3
export const DONE_FOLD_ROWS = 5

/** id → 会话内 UI 元数据（task/workflow 用；session 的 pin/sortOrder/name 走 JobState durable）。 */
export type FleetOverlay = Record<string, { pinned?: boolean; sortOrder?: number; name?: string }>

export interface FleetJob {
  id: string
  kind: FleetKind
  backend: FleetBackend
  name: string
  detail: string
  band: FleetBand
  status?: FleetStatus          // 仅终态
  tempo: FleetTempo
  pinned: boolean
  sortOrder?: number
  cwd: string
  createdAt: number
  updatedAt: number
}

/** 活跃度推导：乘子 running=1 / idle=5；<3min flowing、<15min slowing、否则 stuck。 */
export function deriveTempo(updatedAt: number, running: boolean, now: number): FleetTempo {
  const o = running ? 1 : 5
  const s = now - updatedAt
  if (s < o * 3 * 60000) return 'flowing'
  if (s < o * 15 * 60000) return 'slowing'
  return 'stuck'
}

export function mapSession(j: JobState, now: number): FleetJob {
  const running = j.state === 'working'
  const status: FleetStatus | undefined = running ? undefined
    : j.state === 'completed' ? 'success' : j.state === 'stopped' ? 'stopped' : 'failed'
  return {
    id: j.short, kind: 'session', backend: 'detached',
    name: j.name, detail: j.initialPrompt ?? '',
    band: running ? 'working' : 'done', status,
    tempo: deriveTempo(j.updatedAt, running, now),
    pinned: j.pinned ?? false, sortOrder: j.sortOrder,
    cwd: j.cwd, createdAt: j.createdAt, updatedAt: j.updatedAt,
  }
}

export function mapTask(t: BackgroundTask, overlay: FleetOverlay, cwd: string, now: number): FleetJob {
  const running = t.status === 'running'
  const status: FleetStatus | undefined = running ? undefined
    : t.status === 'completed' ? 'success' : t.status === 'killed' ? 'stopped' : 'failed'
  const ov = overlay[t.id] ?? {}
  const label = t.kind === 'monitor' ? 'monitor'
    : t.type === 'local_agent' ? 'agent' : t.type === 'local_bash' ? 'bash'
    : t.type === 'local_workflow' ? 'workflow' : 'hook'
  const updatedAt = t.endTime ?? t.startTime
  return {
    id: t.id, kind: 'task', backend: 'local',
    name: ov.name ?? t.description, detail: t.command ?? t.prompt ?? label,
    band: running ? 'working' : 'done', status,
    tempo: deriveTempo(updatedAt, running, now),
    pinned: ov.pinned ?? false, sortOrder: ov.sortOrder,
    cwd, createdAt: t.startTime, updatedAt,
  }
}

export function mapWorkflow(w: WorkflowRunSummary, overlay: FleetOverlay, cwd: string): FleetJob {
  const ov = overlay[w.runId] ?? {}
  return {
    id: w.runId, kind: 'workflow', backend: 'local',
    name: ov.name ?? (w.name || w.runId),
    detail: w.phases.length ? w.phases[w.phases.length - 1].title : `${w.agents} agents`,
    band: w.done ? 'done' : 'working', status: w.done ? 'success' : undefined,
    tempo: 'flowing',                        // 工作流无 per-update 时间戳，运行中恒 flowing
    pinned: ov.pinned ?? false, sortOrder: ov.sortOrder,
    cwd, createdAt: 0, updatedAt: 0,
  }
}

export type FleetRow =
  | { kind: 'header'; group: string }
  | { kind: 'job'; job: FleetJob }
  | { kind: 'fold'; hidden: number }

export function effOrder(j: FleetJob): number {
  return j.sortOrder ?? j.createdAt
}

export function sortFleet(jobs: FleetJob[]): FleetJob[] {
  return [...jobs].sort((a, b) => effOrder(a) - effOrder(b))
}

export function groupFleet(
  jobs: FleetJob[], mode: FleetGroupMode, doneFoldAt: number, foldExpanded: boolean,
): { rows: FleetRow[]; visibleJobs: FleetJob[] } {
  const sorted = sortFleet(jobs)
  const rows: FleetRow[] = []
  const visibleJobs: FleetJob[] = []

  if (mode === 'cwd') {
    const groups = new Map<string, FleetJob[]>()
    for (const j of sorted) {
      const k = j.cwd || '(no cwd)'
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(j)
    }
    for (const [k, js] of groups) {
      rows.push({ kind: 'header', group: k })
      for (const j of js) { rows.push({ kind: 'job', job: j }); visibleJobs.push(j) }
    }
    return { rows, visibleJobs }
  }

  // state 模式：pinned 浮顶 → working → done（done 可折叠）
  const pinned = sorted.filter(j => j.pinned)
  const working = sorted.filter(j => !j.pinned && j.band === 'working')
  const done = sorted.filter(j => !j.pinned && j.band === 'done')
  const pushBand = (label: string, js: FleetJob[], foldable: boolean) => {
    if (js.length === 0) return
    rows.push({ kind: 'header', group: label })
    let shown = 0
    for (const j of js) {
      if (foldable && !foldExpanded && shown >= doneFoldAt) break
      rows.push({ kind: 'job', job: j }); visibleJobs.push(j); shown++
    }
    if (foldable && !foldExpanded && js.length > doneFoldAt) {
      rows.push({ kind: 'fold', hidden: js.length - doneFoldAt })
    }
  }
  pushBand('pinned', pinned, false)
  pushBand('working', working, false)
  pushBand('done', done, true)
  return { rows, visibleJobs }
}

export function computePeak(prev: number, jobs: FleetJob[]): number {
  const working = jobs.filter(j => j.band === 'working').length
  return Math.max(prev, working)
}

/**
 * 防御性纵深：workflow 目录名（FleetJob id）在 stopOrDelete 里直接拼进 rmSync 路径。
 * journal 内容里的 runId 是不可信的（见 WorkflowView.formatWorkflowProgress），万一被当成 id
 * 传进来，这里再兜底校验解析后的路径没有跑出 .deepcode/workflows/ 目录。合法则返回目标路径，否则 null。
 */
export function safeWorkflowDir(cwd: string, id: string): string | null {
  const base = path.resolve(cwd, '.deepcode', 'workflows')
  const target = path.resolve(base, id)
  return target === base || target.startsWith(base + path.sep) ? target : null
}

export interface CollectOpts {
  jobs: JobState[]
  tasks: BackgroundTask[]
  workflowRuns: WorkflowRunSummary[]
  overlay: FleetOverlay
  cwd: string
  now: number
}

/** 三源归一为 FleetJob（纯）。单条映射失败跳过不影响其余（容错）。 */
export function collectFleet(o: CollectOpts): FleetJob[] {
  const out: FleetJob[] = []
  for (const j of o.jobs) { try { out.push(mapSession(j, o.now)) } catch { /* skip */ } }
  for (const t of o.tasks) {
    try {
      // local_workflow 任务是 registerTask 侧写的伴生 BackgroundTask；同一次运行的 journal
      // （下方 workflowRuns 循环）才是工作流的权威来源。两者都映射会让同一工作流出现两行，
      // computePeak 也会被重复计入——这里跳过任务侧的影子记录，避免双计数。
      if (t.type === 'local_workflow') continue
      out.push(mapTask(t, o.overlay, o.cwd, o.now))
    } catch { /* skip */ }
  }
  for (const w of o.workflowRuns) { try { out.push(mapWorkflow(w, o.overlay, o.cwd)) } catch { /* skip */ } }
  return out
}
