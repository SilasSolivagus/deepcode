// test/backgroundRunner.activity.test.ts —— Task 6：后台会话的活动日志接线 + 双写修复
// 后台会话恰恰是用户看不见的活动，dream 挖掘价值最高；同时修 updateJobState 抛错时消息被 append 两遍。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let memRoot: string
vi.mock('../src/memdir/paths.js', async orig => {
  const actual = await orig<typeof import('../src/memdir/paths.js')>()
  return { ...actual, memdirFor: () => memRoot }
})

const script: Array<{ result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })(),
  ),
}))

const mockSettings: any = { permissions: { allow: [] }, maxToolResultChars: 100_000 }
vi.mock('../src/settingsLayers.js', async orig => {
  const actual = await orig<typeof import('../src/settingsLayers.js')>()
  return {
    ...actual,
    loadLayeredSettings: vi.fn(() => ({
      settings: mockSettings, provenance: {},
      permissionSources: { allow: {}, deny: {} }, scopes: [],
    })),
  }
})

// updateJobState 可按需抛错：复现「completed 落状态失败 → catch 里把同一批消息再 append 一遍」
let throwOnState: string | null = null
vi.mock('../src/backgroundSession.js', async orig => {
  const actual = await orig<typeof import('../src/backgroundSession.js')>()
  return {
    ...actual,
    updateJobState: vi.fn((short: string, patch: any) => {
      if (throwOnState && patch?.state === throwOnState) throw new Error('磁盘炸了')
      return actual.updateJobState(short, patch)
    }),
  }
})

import { newSession } from '../src/session.js'
import { writeJobState, readJobState } from '../src/backgroundSession.js'
import { runBackgroundSession } from '../src/backgroundRunner.js'

const usage = { prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 0 }

let tmp: string, sessDir: string
beforeEach(() => {
  script.length = 0
  throwOnState = null
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgact-'))
  memRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgact-mem-'))
  process.env.DEEPCODE_TEST_HOME = tmp
  sessDir = path.join(tmp, 'sessions')
})
afterEach(() => {
  delete process.env.DEEPCODE_TEST_HOME
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(memRoot, { recursive: true, force: true })
})

function seedSession(): { file: string; short: string } {
  const h = newSession({ cwd: tmp, model: 'glm-5.2', thinking: false, permMode: 'default' }, sessDir)
  h.appendMessage({ role: 'system', content: 'sys' })
  const short = path.basename(h.file).replace(/\.jsonl$/, '').slice(0, 8)
  writeJobState({
    sessionId: path.basename(h.file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp,
    name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: h.file,
    backend: 'detached', createdAt: 1, updatedAt: 1,
  })
  return { file: h.file, short }
}

const logFiles = (): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.name.endsWith('.md')) out.push(f)
    }
  }
  try { walk(path.join(memRoot, 'logs')) } catch { /* 还没有日志 */ }
  return out
}
const count = (txt: string, re: RegExp) => (txt.match(re) ?? []).length

describe('后台会话活动日志', () => {
  it('seed 与助手结论写进活动日志', async () => {
    const { file, short } = seedSession()
    script.push({ result: { content: '后台跑完了', toolCalls: [], usage, finishReason: 'stop' } })
    await runBackgroundSession({ client: {} as any, resumeFile: file, jobShort: short, seed: '继续干' })

    expect(readJobState(short)?.state).toBe('completed')
    expect(logFiles().length).toBe(1)
    const txt = fs.readFileSync(logFiles()[0], 'utf8')
    expect(txt).toContain('> 继续干')
    expect(txt).toContain('< 后台跑完了')
  })

  it('updateJobState 抛错时不把本轮消息再 append 一遍（双写修复）', async () => {
    const { file, short } = seedSession()
    throwOnState = 'completed'
    script.push({ result: { content: '后台跑完了', toolCalls: [], usage, finishReason: 'stop' } })
    await runBackgroundSession({ client: {} as any, resumeFile: file, jobShort: short, seed: '继续干' })

    const raw = fs.readFileSync(file, 'utf8')
    expect(count(raw, /后台跑完了/g)).toBe(1)  // 既有 bug：会是 2
    const txt = fs.readFileSync(logFiles()[0], 'utf8')
    expect(count(txt, /^< 后台跑完了$/gm)).toBe(1)
  })
})
