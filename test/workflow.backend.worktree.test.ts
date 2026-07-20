import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeInProcessBackend } from '../src/workflow/backend.js'

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-wt-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  writeFileSync(path.join(dir, 'seed.txt'), 'seed')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

function makeDeps(dir: string, runSubagent: any) {
  return {
    runSubagent,
    sessionModel: 'm',
    client: {} as any,
    onUsage: () => {},
    ctx: { cwd: () => dir, hookDispatch: undefined } as any,
    signal: new AbortController().signal,
    agents: [],
    toolPool: [],
  }
}

describe('workflow backend worktree 隔离', () => {
  let dir: string
  beforeEach(() => { dir = initRepo() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('isolation:worktree → 建 worktree 并把 worktreePath 传给 runSubagent；子代理有改动则保留+回传 path/branch', async () => {
    let seen: string | undefined
    const runSubagent = vi.fn(async (opts: any) => {
      seen = opts.worktreePath
      writeFileSync(path.join(opts.worktreePath, 'new.txt'), 'x') // 模拟改动
      return 'done'
    })
    const backend = makeInProcessBackend(makeDeps(dir, runSubagent))
    const out = await backend.runAgent({ prompt: 'p', opts: { isolation: 'worktree' }, agentId: 'wfa_0', index: 0 })
    expect(seen).toBeTruthy()
    expect(out.status).toBe('ok')
    expect(out.worktree?.path).toBe(seen)
    expect(out.worktree?.branch).toMatch(/agent-/)
    expect(existsSync(seen!)).toBe(true) // 有改动→保留
  })

  it('子代理无改动 → worktree 被删、无 worktree 回传', async () => {
    let seen: string | undefined
    const runSubagent = vi.fn(async (opts: any) => { seen = opts.worktreePath; return 'noop' })
    const backend = makeInProcessBackend(makeDeps(dir, runSubagent))
    const out = await backend.runAgent({ prompt: 'p', opts: { isolation: 'worktree' }, agentId: 'wfa_1', index: 0 })
    expect(out.status).toBe('ok')
    expect(out.worktree).toBeUndefined()
    expect(existsSync(seen!)).toBe(false) // 无改动→删
  })

  it('非 git 仓库 + 无 hook → status:error（不抛）', async () => {
    const nonGit = mkdtempSync(path.join(tmpdir(), 'wf-nogit-'))
    const backend = makeInProcessBackend(makeDeps(nonGit, vi.fn()))
    const out = await backend.runAgent({ prompt: 'p', opts: { isolation: 'worktree' }, agentId: 'wfa_2', index: 0 })
    expect(out.status).toBe('error')
    rmSync(nonGit, { recursive: true, force: true })
  })

  it('无 isolation → 不建 worktree，worktreePath undefined', async () => {
    let seen: string | undefined = 'X'
    const runSubagent = vi.fn(async (opts: any) => { seen = opts.worktreePath; return 'ok' })
    const backend = makeInProcessBackend(makeDeps(dir, runSubagent))
    await backend.runAgent({ prompt: 'p', opts: {}, agentId: 'wfa_3', index: 0 })
    expect(seen).toBeUndefined()
  })

  it('两个并发工作流跑 → 同一 agentId(wfa_0) 不撞名，均 status:ok 不抛', async () => {
    const backendA = makeInProcessBackend(makeDeps(dir, vi.fn(async (opts: any) => {
      writeFileSync(path.join(opts.worktreePath, 'a.txt'), 'a')
      return 'done-a'
    })))
    const backendB = makeInProcessBackend(makeDeps(dir, vi.fn(async (opts: any) => {
      writeFileSync(path.join(opts.worktreePath, 'b.txt'), 'b')
      return 'done-b'
    })))
    const [outA, outB] = await Promise.all([
      backendA.runAgent({ prompt: 'p', opts: { isolation: 'worktree' }, agentId: 'wfa_0', index: 0 }),
      backendB.runAgent({ prompt: 'p', opts: { isolation: 'worktree' }, agentId: 'wfa_0', index: 0 }),
    ])
    expect(outA.status).toBe('ok')
    expect(outB.status).toBe('ok')
    expect(outA.worktree?.path).not.toBe(outB.worktree?.path)
  })
})
