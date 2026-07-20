// Task6：双组件接线的两个纯逻辑门控——折叠门控 shouldFold + anyRunningWork 的 band 判据。
import { describe, it, expect } from 'vitest'
import { shouldFold } from '../src/tui/focusFold.js'
import { collectFleet, type FleetJob } from '../src/fleet.js'
import type { JobState } from '../src/backgroundSession.js'

const T0 = 1_000_000_000_000
function job(p: Partial<JobState>): JobState {
  return { sessionId: 's', short: 'abc12345', state: 'working', cwd: '/w', name: 'sess',
    pid: 123, model: 'm', permMode: 'default', sessionFile: '/w/s.jsonl',
    backend: 'detached', createdAt: T0, updatedAt: T0, ...p }
}

describe('shouldFold（折叠门控）', () => {
  it('仅全屏组件 + focusMode 时折叠', () => {
    expect(shouldFold(true, true)).toBe(true)
  })
  it('内联组件恒不折叠（即便 focus 开）', () => {
    expect(shouldFold(false, true)).toBe(false)
  })
  it('全屏但 focus 关 → 不折叠', () => {
    expect(shouldFold(true, false)).toBe(false)
  })
  it('内联 + focus 关 → 不折叠', () => {
    expect(shouldFold(false, false)).toBe(false)
  })
})

describe('anyRunningWork 判据（band==="working"，非 status==="running"）', () => {
  // core.anyRunningWork() 用 fleet.some(w => w.band === 'working')。
  // 回归护栏：运行中的 FleetJob band==='working' 且 status===undefined——
  // 若误用 status==='running' 会永远判成「无运行中工作」，放行本应门控的 /tui 切换。
  const anyRunningWork = (fleet: FleetJob[]) => fleet.some(w => w.band === 'working')

  it('运行中的后台会话被 band 判据识别', () => {
    const fleet = collectFleet({ jobs: [job({ state: 'working' })], tasks: [], workflowRuns: [], overlay: {}, cwd: '/w', now: T0 })
    expect(anyRunningWork(fleet)).toBe(true)
    // 反证：status 上没有 'running' 这个值，误用会漏判
    expect(fleet.some(w => (w as any).status === 'running')).toBe(false)
  })

  it('仅有终态会话（completed）→ 无运行中工作', () => {
    const fleet = collectFleet({ jobs: [job({ state: 'completed' })], tasks: [], workflowRuns: [], overlay: {}, cwd: '/w', now: T0 })
    expect(anyRunningWork(fleet)).toBe(false)
  })

  it('空 fleet → 无运行中工作', () => {
    expect(anyRunningWork([])).toBe(false)
  })
})
