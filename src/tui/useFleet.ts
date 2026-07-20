// src/tui/useFleet.ts
// 7.4 FleetView 状态/刷新/动作共享钩子，App.tsx 与 FullscreenApp.tsx 共用（双组件不重复逻辑）。
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { collectFleet, groupFleet, computePeak, safeWorkflowDir, DONE_FOLD_ROWS, type FleetOverlay, type FleetJob, type FleetGroupMode } from '../fleet.js'
import { reconcileJobs, updateJobState, jobStateDir } from '../backgroundSession.js'
import { listTasks, removeTask, onNotification, stopTask } from '../tasks.js'
import { formatWorkflowProgress, type WorkflowRunSummary } from './WorkflowView.js'

export function loadWorkflowRuns(cwd: string): WorkflowRunSummary[] {
  const dir = path.join(cwd, '.deepcode', 'workflows')
  const runs: WorkflowRunSummary[] = []
  try {
    for (const runId of fs.readdirSync(dir)) {
      try {
        const raw = fs.readFileSync(path.join(dir, runId, 'journal.jsonl'), 'utf8')
        const records = raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
        const isDone = records.some((r: any) => r.type === 'workflow_complete')
        // formatWorkflowProgress 可能把 runId 覆盖成 journal 内容里的 workflow_complete.runId（不可信，
        // 未受信任项目里可被伪造）。这里强制用 readdir 出来的目录名（可信身份）盖回去，
        // 避免被当成 FleetJob id 传进 stopOrDelete 的 rmSync 路径。
        runs.push({ ...formatWorkflowProgress(records, { id: runId, status: isDone ? 'completed' : 'running' }), runId })
      } catch { /* skip bad journal */ }
    }
  } catch { /* no dir */ }
  return runs
}

export interface FleetController {
  rows: ReturnType<typeof groupFleet>['rows']
  visibleJobs: FleetJob[]
  selectedId: string | null
  setSelectedId(id: string | null): void
  groupMode: FleetGroupMode
  peak: number
  foldExpanded: boolean
  renaming: { id: string; buffer: string } | null
  setRenaming(r: { id: string; buffer: string } | null): void
  confirming: { id: string; action: 'stop' | 'delete' } | null
  setConfirming(c: { id: string; action: 'stop' | 'delete' } | null): void
  toggleGroup(): void
  toggleHelp(): void
  pin(job: FleetJob): void
  rename(job: FleetJob, name: string): void
  reorder(job: FleetJob, dir: 1 | -1): void
  stopOrDelete(job: FleetJob): void
  openJob(job: FleetJob): void
}

/** active=面板是否挂载：为 true 时订阅通知 + 2s 轮询刷新。 */
export function useFleet(cwd: string, active: boolean, onOpenSession: (file: string) => void): FleetController {
  const [tick, setTick] = useState(0)
  const [groupMode, setGroupMode] = useState<FleetGroupMode>('state')
  const [foldExpanded, setFoldExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; buffer: string } | null>(null)
  const [confirming, setConfirming] = useState<{ id: string; action: 'stop' | 'delete' } | null>(null)
  const overlayRef = useRef<FleetOverlay>({})
  const peakRef = useRef(0)
  const refresh = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    if (!active) return
    const unsub = onNotification(refresh)
    const timer = setInterval(refresh, 2000)
    return () => { unsub(); clearInterval(timer) }
  }, [active, refresh])

  // 采集（仅 tick/cwd 变化才重算，避免纯导航/改名的重渲染也触发磁盘 I/O）。
  // reconcileJobs 有落盘副作用，放这里而非纯 collectFleet。
  const { fleet, jobs } = useMemo(() => {
    const now = Date.now()
    const jobs = reconcileJobs(now)
    const fleet = collectFleet({ jobs, tasks: listTasks(), workflowRuns: loadWorkflowRuns(cwd), overlay: overlayRef.current, cwd, now })
    peakRef.current = computePeak(peakRef.current, fleet)
    return { fleet, jobs }
  }, [tick, cwd])  // eslint-disable-line react-hooks/exhaustive-deps
  // rows/visibleJobs：纯计算，group/fold 切换需即时生效 → 每渲染都算（不进 useMemo 的磁盘采集）。
  const { rows, visibleJobs } = groupFleet(fleet, groupMode, DONE_FOLD_ROWS, foldExpanded)

  // 会话 pin/sortOrder/name 写回 JobState（durable）；task/workflow 写内存 overlay。
  const setMeta = (job: FleetJob, patch: { pinned?: boolean; sortOrder?: number; name?: string }) => {
    if (job.kind === 'session') updateJobState(job.id, patch)
    else overlayRef.current[job.id] = { ...overlayRef.current[job.id], ...patch }
    refresh()
  }

  return {
    rows, visibleJobs, selectedId, setSelectedId, groupMode, peak: peakRef.current, foldExpanded,
    renaming, setRenaming, confirming, setConfirming,
    toggleGroup: () => setGroupMode(m => m === 'state' ? 'cwd' : 'state'),
    toggleHelp: () => setFoldExpanded(e => !e),   // done-fold 展开切换复用 ? 键
    pin: (job) => setMeta(job, { pinned: !job.pinned }),
    rename: (job, name) => setMeta(job, { name: name.trim() || job.name }),
    reorder: (job, dir) => {
      // 与相邻同带 job 交换 effOrder：简单实现为把当前 sortOrder 设为邻居 effOrder ± 0.5，再规整为整数序
      // peers 限定同 band，避免（如working 末尾 ↔ done 首个）跨带交换。
      const peers = visibleJobs.filter(j => j.band === job.band)
      const idx = peers.findIndex(j => j.id === job.id)
      const swapIdx = idx + dir
      if (idx < 0 || swapIdx < 0 || swapIdx >= peers.length) return
      const cur = job.sortOrder ?? job.createdAt
      const other = peers[swapIdx].sortOrder ?? peers[swapIdx].createdAt
      setMeta(job, { sortOrder: other })
      setMeta(peers[swapIdx], { sortOrder: cur })
    },
    stopOrDelete: (job) => {
      if (job.band === 'working') {
        // 停止：session→SIGTERM(pid)、task→stopTask（按类型分派 kill 进程组/kill hook child/abort，统一落 status=killed）
        if (job.kind === 'session') { const j = jobs.find(x => x.short === job.id); if (j?.pid) { try { process.kill(j.pid, 'SIGTERM') } catch { /* 已死 */ } } }
        else if (job.kind === 'task') stopTask(job.id, Date.now())
      } else {
        // 删除归档：session→删目录、task→removeTask、workflow→删 journal 目录
        if (job.kind === 'session') { try { fs.rmSync(jobStateDir(job.id), { recursive: true, force: true }) } catch { /* 尽力 */ } }
        else if (job.kind === 'task') removeTask(job.id)
        else {
          // 纵深防御：即便 job.id 以某种方式被污染，safeWorkflowDir 也会拒绝跑出 workflows 目录的路径。
          const dir = safeWorkflowDir(cwd, job.id)
          if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力 */ } }
        }
        delete overlayRef.current[job.id]
      }
      refresh()
    },
    openJob: (job: FleetJob) => {
      if (job.kind === 'session') { const j = jobs.find(x => x.short === job.id); if (j) onOpenSession(j.sessionFile) }
      // workflow 由父层处理；task 无独立查看器 → no-op（输出经 task-notification 已达）
    },
  }
}
