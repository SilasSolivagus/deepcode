import { describe, it, expect, vi } from 'vitest'
import { buildCarryFlags, buildResumeArgs, buildSwitchEnv, guardSwitch, performTuiSwitch } from '../src/tui/tuiSwitch.js'

describe('buildCarryFlags', () => {
  it('yolo 才带 --yolo（model/permMode/add-dir 由 resume-meta 恢复，不 carry）', () => {
    expect(buildCarryFlags({ yolo: true })).toEqual(['--yolo'])
  })
  it('无 yolo 无 settings 则空', () => {
    expect(buildCarryFlags({ yolo: false })).toEqual([])
  })
  it('settingsPath 携带 --settings <path>（拼在 --yolo 之后）', () => {
    expect(buildCarryFlags({ yolo: true, settingsPath: '/cfg/dc.json' }))
      .toEqual(['--yolo', '--settings', '/cfg/dc.json'])
  })
  it('无 yolo 但有 settingsPath 则只带 --settings', () => {
    expect(buildCarryFlags({ yolo: false, settingsPath: '/cfg/dc.json' }))
      .toEqual(['--settings', '/cfg/dc.json'])
  })
})

describe('buildResumeArgs', () => {
  it('有会话+有对话则精确 resume', () => {
    expect(buildResumeArgs({ sessionFile: '/s/x.jsonl', hasTranscript: true })).toEqual(['--resume', '/s/x.jsonl'])
  })
  it('空会话不带 resume（freshIfNoTranscript）', () => {
    expect(buildResumeArgs({ sessionFile: '/s/x.jsonl', hasTranscript: false })).toEqual([])
  })
})

describe('buildSwitchEnv', () => {
  it('设握手 env 并删 DEEPCODE_INLINE', () => {
    const env = buildSwitchEnv('fullscreen', { DEEPCODE_INLINE: '1', PATH: '/x' })
    expect(env.DEEPCODE_TUI_JUST_SWITCHED).toBe('fullscreen')
    expect(env.DEEPCODE_INLINE).toBeUndefined()
    expect(env.PATH).toBe('/x')
  })
})

describe('guardSwitch', () => {
  it('bg 会话拒绝', () => {
    const r = guardSwitch({ bg: true, anyRunningWork: false })
    expect(r.ok).toBe(false)
  })
  it('有运行中后台工作拒绝', () => {
    expect(guardSwitch({ bg: false, anyRunningWork: true }).ok).toBe(false)
  })
  it('都无则放行', () => {
    expect(guardSwitch({ bg: false, anyRunningWork: false }).ok).toBe(true)
  })
  it('bg 和运行中都为 true 也拒绝', () => {
    expect(guardSwitch({ bg: true, anyRunningWork: true }).ok).toBe(false)
  })
  it('bg-only 与 running-only 的拒绝文案非空且不同', () => {
    const bgOnly = guardSwitch({ bg: true, anyRunningWork: false })
    const runningOnly = guardSwitch({ bg: false, anyRunningWork: true })
    if (bgOnly.ok || runningOnly.ok) throw new Error('expected both to be refused')
    expect(bgOnly.message.length).toBeGreaterThan(0)
    expect(runningOnly.message.length).toBeGreaterThan(0)
    expect(bgOnly.message).not.toBe(runningOnly.message)
  })
})

describe('performTuiSwitch', () => {
  it('先 save 再 unmount 再 spawn（顺序）', () => {
    const calls: string[] = []
    const spawnSync = vi.fn(() => { calls.push('spawn'); return { status: 0 } as any })
    const save = vi.fn(() => { calls.push('save'); return { error: null } })
    const unmount = vi.fn(() => calls.push('unmount'))
    const exit = vi.fn()
    performTuiSwitch({
      target: 'fullscreen', guardCtx: { bg: false, anyRunningWork: false },
      state: { yolo: false }, resume: { sessionFile: '/s.jsonl', hasTranscript: true },
      entryScript: '/dist/index.js', execPath: 'node', baseEnv: {},
      saveSettings: save, unmount, spawnSync, exit,
    })
    expect(calls).toEqual(['save', 'unmount', 'spawn'])
    expect(exit).toHaveBeenCalledWith(0)
  })
  it('save 失败则不 spawn', () => {
    const spawnSync = vi.fn()
    performTuiSwitch({
      target: 'inline', guardCtx: { bg: false, anyRunningWork: false },
      state: { yolo: false }, resume: { hasTranscript: false },
      entryScript: '/d.js', execPath: 'node', baseEnv: {},
      saveSettings: () => ({ error: new Error('boom') }),
      unmount: () => {}, spawnSync, exit: () => {},
      onError: () => {},
    })
    expect(spawnSync).not.toHaveBeenCalled()
  })
  // unmount 之后 ink 树已卸载，onError→notice 用户根本看不见；且不退出会留下「UI 已死、进程还挂着」的僵尸。
  // 故 unmount 之后的失败改为写 stderr + 非零退出（onError 只服务于 unmount 之前的门控失败）。
  it('spawnSync 返回 error（未抛出，此时已 unmount）→ 非零退出，不用看不见的 onError', () => {
    const spawnSync = vi.fn(() => ({ status: null, error: new Error('ENOENT') }) as any)
    const exit = vi.fn()
    const onError = vi.fn()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    performTuiSwitch({
      target: 'fullscreen', guardCtx: { bg: false, anyRunningWork: false },
      state: { yolo: false }, resume: { hasTranscript: false },
      entryScript: '/d.js', execPath: 'node', baseEnv: {},
      saveSettings: () => ({ error: null }),
      unmount: () => {}, spawnSync, exit,
      onError,
    })
    expect(err).toHaveBeenCalledWith(expect.stringContaining('ENOENT'))
    expect(exit).toHaveBeenCalledWith(1)
    expect(onError).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('子进程被信号杀死（status=null）→ 不谎报成功，非零退出', () => {
    const spawnSync = vi.fn(() => ({ status: null }) as any)
    const exit = vi.fn()
    performTuiSwitch({
      target: 'fullscreen', guardCtx: { bg: false, anyRunningWork: false },
      state: { yolo: false }, resume: { hasTranscript: false },
      entryScript: '/d.js', execPath: 'node', baseEnv: {},
      saveSettings: () => ({ error: null }),
      unmount: () => {}, spawnSync, exit,
    })
    expect(exit).toHaveBeenCalledWith(1)
  })
})
