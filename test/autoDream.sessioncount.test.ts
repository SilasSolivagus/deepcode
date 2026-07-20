// 端到端：从 gate.n 到 prompt 正文——修「dream prompt 会话数恒为 0」的既有 bug
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runAutoDream } from '../src/services/memory/autoDream.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

describe('runAutoDream：prompt 中的会话数来自 gate.n（不再恒为 0）', () => {
  let md: string, sd: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dr2-')); sd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-drs2-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }); fs.rmSync(sd, { recursive: true, force: true }) })

  it('gate 返回 n=7 时，userPrompt 里出现 7，而非 0；未传 sessionCount 也不影响', async () => {
    let capturedPrompt = ''
    const runSub = vi.fn(async (opts: { userPrompt: string }) => { capturedPrompt = opts.userPrompt; return 'done' })
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal, cwd: () => md } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub,
      gate: () => ({ pass: true, n: 7, sessionFiles: ['/s/a.jsonl'] }),
      // 注意：故意不传 sessionCount，验证不再依赖它
    })
    expect(runSub).toHaveBeenCalled()
    expect(capturedPrompt).toContain('7')
    expect(capturedPrompt).not.toMatch(/约\s*0\s*个会话/)
  })
})
