import { describe, it, expect } from 'vitest'
import {
  deriveTempo, mapSession, mapTask, mapWorkflow, type FleetOverlay,
  sortFleet, groupFleet, computePeak, collectFleet, safeWorkflowDir, type FleetJob,
} from '../src/fleet.js'
import type { JobState } from '../src/backgroundSession.js'
import type { BackgroundTask } from '../src/tasks.js'
import type { WorkflowRunSummary } from '../src/tui/WorkflowView.js'

const T0 = 1_000_000_000_000

function job(p: Partial<JobState>): JobState {
  return { sessionId: 's', short: 'abc12345', state: 'working', cwd: '/w', name: 'sess',
    pid: 123, model: 'm', permMode: 'default', sessionFile: '/w/s.jsonl',
    backend: 'detached', createdAt: T0, updatedAt: T0, ...p }
}

describe('deriveTempo', () => {
  it('running: <3min flowing, <15min slowing, else stuck', () => {
    expect(deriveTempo(T0, true, T0 + 2 * 60000)).toBe('flowing')
    expect(deriveTempo(T0, true, T0 + 10 * 60000)).toBe('slowing')
    expect(deriveTempo(T0, true, T0 + 20 * 60000)).toBe('stuck')
  })
  it('idle: thresholds ×5 (15min flowing, 75min slowing)', () => {
    expect(deriveTempo(T0, false, T0 + 10 * 60000)).toBe('flowing')
    expect(deriveTempo(T0, false, T0 + 60 * 60000)).toBe('slowing')
    expect(deriveTempo(T0, false, T0 + 80 * 60000)).toBe('stuck')
  })
})

describe('mapSession', () => {
  it('working → band working, no status', () => {
    const f = mapSession(job({ state: 'working' }), T0)
    expect(f).toMatchObject({ kind: 'session', backend: 'detached', band: 'working', status: undefined, pinned: false })
  })
  it('completed/failed/stopped → done + status', () => {
    expect(mapSession(job({ state: 'completed' }), T0)).toMatchObject({ band: 'done', status: 'success' })
    expect(mapSession(job({ state: 'failed' }), T0)).toMatchObject({ band: 'done', status: 'failed' })
    expect(mapSession(job({ state: 'stopped' }), T0)).toMatchObject({ band: 'done', status: 'stopped' })
  })
  it('reads pinned/sortOrder from JobState', () => {
    expect(mapSession(job({ pinned: true, sortOrder: 42 }), T0)).toMatchObject({ pinned: true, sortOrder: 42 })
  })
})

describe('mapTask', () => {
  const base: BackgroundTask = { id: 'a1', type: 'local_agent', status: 'running',
    description: 'find bugs', startTime: T0, outputFile: '/o', outputOffset: 0, notified: false }
  it('running → working; killed → done/stopped', () => {
    expect(mapTask({ ...base, status: 'running' }, {}, '/w', T0)).toMatchObject({ kind: 'task', backend: 'local', band: 'working' })
    expect(mapTask({ ...base, status: 'killed', endTime: T0 }, {}, '/w', T0)).toMatchObject({ band: 'done', status: 'stopped' })
    expect(mapTask({ ...base, status: 'failed', endTime: T0 }, {}, '/w', T0)).toMatchObject({ band: 'done', status: 'failed' })
  })
  it('overlay 覆盖 name/pinned/sortOrder', () => {
    const ov: FleetOverlay = { a1: { name: 'renamed', pinned: true, sortOrder: 7 } }
    expect(mapTask(base, ov, '/w', T0)).toMatchObject({ name: 'renamed', pinned: true, sortOrder: 7 })
  })
})

describe('mapWorkflow', () => {
  const run: WorkflowRunSummary = { runId: 'w1', name: 'review', done: false, agents: 3, ms: 0, phases: [{ title: 'Find', agents: 3 }] }
  it('running → working; done → done/success', () => {
    expect(mapWorkflow(run, {}, '/w')).toMatchObject({ kind: 'workflow', band: 'working', detail: 'Find' })
    expect(mapWorkflow({ ...run, done: true }, {}, '/w')).toMatchObject({ band: 'done', status: 'success' })
  })
})

function fj(p: Partial<FleetJob>): FleetJob {
  return { id: 'x', kind: 'task', backend: 'local', name: 'n', detail: 'd',
    band: 'working', tempo: 'flowing', pinned: false, cwd: '/w', createdAt: 0, updatedAt: 0, ...p }
}

describe('sortFleet', () => {
  it('按 sortOrder??createdAt 升序', () => {
    const r = sortFleet([fj({ id: 'a', createdAt: 30 }), fj({ id: 'b', sortOrder: 5, createdAt: 99 }), fj({ id: 'c', createdAt: 10 })])
    expect(r.map(j => j.id)).toEqual(['b', 'c', 'a'])  // 5 < 10 < 30
  })
})

describe('groupFleet state 模式', () => {
  const jobs = [
    fj({ id: 'p', pinned: true, band: 'done', createdAt: 1 }),
    fj({ id: 'w1', band: 'working', createdAt: 2 }),
    fj({ id: 'd1', band: 'done', createdAt: 3 }),
  ]
  it('pinned 浮顶 → working → done，各带带 header', () => {
    const { rows, visibleJobs } = groupFleet(jobs, 'state', 5, false)
    const groups = rows.filter(r => r.kind === 'header').map(r => (r as any).group)
    expect(groups).toEqual(['pinned', 'working', 'done'])
    expect(visibleJobs.map(j => j.id)).toEqual(['p', 'w1', 'd1'])
  })
  it('done 超阈值折叠，产 fold 行 + doneFoldHidden', () => {
    const many = Array.from({ length: 8 }, (_, i) => fj({ id: 'd' + i, band: 'done', createdAt: i }))
    const { rows, visibleJobs } = groupFleet(many, 'state', 5, false)
    expect(visibleJobs.length).toBe(5)
    const fold = rows.find(r => r.kind === 'fold') as any
    expect(fold.hidden).toBe(3)
  })
  it('foldExpanded=true 全显示，无 fold 行', () => {
    const many = Array.from({ length: 8 }, (_, i) => fj({ id: 'd' + i, band: 'done', createdAt: i }))
    const { rows, visibleJobs } = groupFleet(many, 'state', 5, true)
    expect(visibleJobs.length).toBe(8)
    expect(rows.find(r => r.kind === 'fold')).toBeUndefined()
  })
})

describe('groupFleet cwd 模式', () => {
  it('按 cwd 分组', () => {
    const jobs = [fj({ id: 'a', cwd: '/x' }), fj({ id: 'b', cwd: '/y' }), fj({ id: 'c', cwd: '/x' })]
    const { rows } = groupFleet(jobs, 'cwd', 5, false)
    const groups = rows.filter(r => r.kind === 'header').map(r => (r as any).group)
    expect(groups).toEqual(['/x', '/y'])
  })
})

describe('computePeak', () => {
  it('取历史与当前 working 计数的较大值', () => {
    expect(computePeak(2, [fj({ band: 'working' }), fj({ band: 'working' }), fj({ band: 'done' })])).toBe(2)
    expect(computePeak(1, [fj({ band: 'working' }), fj({ band: 'working' }), fj({ band: 'working' })])).toBe(3)
  })
})

describe('collectFleet', () => {
  const T0 = 1_000_000_000_000
  it('三源合并；坏数据跳过不崩', () => {
    // Valid entries
    const validJob = { short: 'j1', state: 'working', name: 'sess', cwd: '/w', initialPrompt: 'go',
      createdAt: T0, updatedAt: T0, sessionId: 's', pid: 1, model: 'm', permMode: 'd', sessionFile: '/f', backend: 'detached' }
    const validTask = { id: 't1', type: 'local_agent', status: 'running', description: 'task', startTime: T0, outputFile: '/o', outputOffset: 0, notified: false }
    const validRun = { runId: 'w1', name: 'wf', done: true, agents: 2, ms: 100, phases: [] }

    // Malformed entries that throw when mapper accesses their properties
    const malformedJob = null as any  // will throw when mapSession accesses .state
    const malformedTask = null as any  // will throw when mapTask accesses .status
    const malformedRun = null as any  // will throw when mapWorkflow accesses .runId

    const jobs = [validJob, malformedJob] as any
    const tasks = [validTask, malformedTask] as any
    const runs = [validRun, malformedRun] as any

    // Verify collectFleet does NOT throw despite malformed entries
    const out = collectFleet({ jobs, tasks, workflowRuns: runs, overlay: {}, cwd: '/w', now: T0 })

    // Only the three valid entries should survive
    expect(out).toHaveLength(3)
    expect(out.map(j => j.kind).sort()).toEqual(['session', 'task', 'workflow'])
    expect(out.find(j => j.kind === 'task')!.cwd).toBe('/w')  // task cwd 取 opts.cwd
  })

  it('local_workflow 任务被跳过（journal/workflow 源才是权威，避免双计数）', () => {
    const workflowTask = { id: 'wf-task-1', type: 'local_workflow', status: 'running', description: 'wf task',
      startTime: T0, outputFile: '/o', outputOffset: 0, notified: false }
    const agentTask = { id: 'agent-1', type: 'local_agent', status: 'running', description: 'agent task',
      startTime: T0, outputFile: '/o', outputOffset: 0, notified: false }
    const workflowRun = { runId: 'wf-task-1', name: 'wf', done: false, agents: 1, ms: 0, phases: [] }

    const out = collectFleet({
      jobs: [], tasks: [workflowTask, agentTask] as any, workflowRuns: [workflowRun] as any,
      overlay: {}, cwd: '/w', now: T0,
    })

    // 没有来自任务侧的 workflow 影子行
    expect(out.find(j => j.kind === 'task' && j.id === 'wf-task-1')).toBeUndefined()
    // local_agent 任务和 journal 里的 workflow 行都还在
    expect(out.find(j => j.kind === 'task' && j.id === 'agent-1')).toBeDefined()
    expect(out.find(j => j.kind === 'workflow' && j.id === 'wf-task-1')).toBeDefined()
    expect(out).toHaveLength(2)
  })
})

describe('safeWorkflowDir', () => {
  it('正常 id 解析到 workflows 目录内', () => {
    const dir = safeWorkflowDir('/proj', 'run-abc123')
    expect(dir).toBe('/proj/.deepcode/workflows/run-abc123')
  })
  it('路径穿越 id 返回 null', () => {
    expect(safeWorkflowDir('/proj', '../../../tmp/pwned')).toBeNull()
    expect(safeWorkflowDir('/proj', '..')).toBeNull()
  })
  it('绝对路径 id 返回 null', () => {
    expect(safeWorkflowDir('/proj', '/etc')).toBeNull()
  })
})
