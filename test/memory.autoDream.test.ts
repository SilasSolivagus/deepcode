import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runAutoDream, buildConsolidationPrompt } from '../src/services/memory/autoDream.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'
import * as memdirToolsMod from '../src/services/memory/memdirTools.js'

test('buildConsolidationPrompt 四阶段', () => {
  const p = buildConsolidationPrompt({ sessionCount: 5, sessionFiles: [], memdir: '/mem', logsDir: '/mem/logs' })
  expect(p).toMatch(/MEMORY\.md/)
  expect(p).toContain('过时'); expect(p).toContain('200')
})

describe('runAutoDream', () => {
  let md: string, sd: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dr-')); sd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-drs-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }); fs.rmSync(sd, { recursive: true, force: true }) })

  test('门控不过 → 不 fork', async () => {
    const runSub = vi.fn(async () => 'ok')
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now: 0, lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: false, n: 0, sessionFiles: [] }),
    })
    expect(runSub).not.toHaveBeenCalled()
  })

  test('门控过 → 取锁 + fork + 成功更新 mtime', async () => {
    const now = Date.now()
    const runSub = vi.fn(async () => 'done')
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now, lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true, n: 5, sessionFiles: [] }),
    })
    expect(runSub).toHaveBeenCalled()
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(true)
    const lockStat = fs.statSync(path.join(md, '.consolidate-lock'))
    expect(lockStat.mtimeMs).toBeGreaterThan(0)
  })

  test('fork 失败 → 回退锁（fail-safe，不抛）', async () => {
    const runSub = vi.fn(async () => { throw new Error('x') })
    await expect(runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true, n: 5, sessionFiles: [] }),
    })).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(false)
  })

  test('门控不过 → onStart/onDone 均不调用', async () => {
    const onStart = vi.fn()
    const onDone = vi.fn()
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now: 0, lastScanAt: 0, gate: () => ({ pass: false, n: 0, sessionFiles: [] }), onStart, onDone,
    })
    expect(onStart).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('门控过，fork 成功 → onStart 取锁后调用，onDone(true) 调用', async () => {
    const runSub = vi.fn(async () => 'done')
    const onStart = vi.fn()
    const onDone = vi.fn()
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true, n: 0, sessionFiles: [] }),
      onStart, onDone,
    })
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith(true)
  })

  test('门控过，fork 失败 → onStart 调用，onDone(false) 调用', async () => {
    const runSub = vi.fn(async () => { throw new Error('boom') })
    const onStart = vi.fn()
    const onDone = vi.fn()
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true, n: 0, sessionFiles: [] }),
      onStart, onDone,
    })
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith(false)
  })

  test('门控过，runSubagent 成功 → onUsage 被透传（与 extract/sessionMemory 对称）', async () => {
    const fakeUsage = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 50 }
    const onUsage = vi.fn()
    // runSub spy 在被调用时主动调用传入的 onUsage，模拟 subagentRunner 的行为
    const runSub = vi.fn(async (opts: { onUsage: (u: typeof fakeUsage, m: string) => void }) => {
      opts.onUsage(fakeUsage, 'm')
      return 'done'
    })
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub as any, gate: () => ({ pass: true, n: 0, sessionFiles: [] }),
      onUsage,
    })
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith(fakeUsage, 'm')
  })

  test('反向哨兵：dream 传给 makeMemdirTools 的 opts 里 globalMemdir 未定义（dream 无权写全局，授权通道不能被悄悄开给它）', async () => {
    const spy = vi.spyOn(memdirToolsMod, 'makeMemdirTools')
    const runSub = vi.fn(async () => 'done')
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true, n: 5, sessionFiles: [] }),
    })
    expect(spy).toHaveBeenCalled()
    const opts = spy.mock.calls[0][1]
    expect(opts?.globalMemdir).toBeUndefined()
    spy.mockRestore()
  })
})
