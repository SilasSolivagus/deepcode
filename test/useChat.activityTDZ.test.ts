// test/useChat.activityTDZ.test.ts —— Minor 1 回归：isReadOnly 闭包不许在 `tools` 声明前引用 `tools` 本身。
// makeActivityWriter 的构造点（newSession/openSession）都在 `const tools = [...]`（useChat.ts:799）之前执行，
// 若 isReadOnly 直接闭包 `tools`，同一 tick 内调用会 TDZ ReferenceError，被 onMessage 外层 try/catch 吞掉，
// 整个 writer 被置 dead —— 该会话一行活动日志都不会写，且毫无报错。
// 用 mock 拦截 createActivityWriter，在构造的那一刻（真实执行时机早于 `tools` 赋值）同步调用 isReadOnly，
// 断言：不抛异常，且工具表尚未回填时按只读处理（返回 true，宁少记不炸）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let memRoot: string
vi.mock('../src/memdir/paths.js', async orig => {
  const actual = await orig<typeof import('../src/memdir/paths.js')>()
  return { ...actual, memdirFor: () => memRoot }
})

const isReadOnlyCallsAtConstruction: Array<{ threw: boolean; result?: boolean }> = []
vi.mock('../src/memdir/activityLog.js', async orig => {
  const actual = await orig<typeof import('../src/memdir/activityLog.js')>()
  return {
    ...actual,
    createActivityWriter: (o: any) => {
      // 在真实构造时机（newSession/openSession 回调内，同步执行，早于 useChat.ts 里 `tools` 的声明）
      // 立即调用 isReadOnly，钉住 TDZ 那一刻的行为。
      try {
        isReadOnlyCallsAtConstruction.push({ threw: false, result: o.isReadOnly?.('Read') })
      } catch {
        isReadOnlyCallsAtConstruction.push({ threw: true })
      }
      return actual.createActivityWriter(o)
    },
  }
})

const script: Array<{ result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })(),
  ),
}))

import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }
const say = (content: string) => script.push({ result: { content, toolCalls: [], usage, finishReason: 'stop' } })

let sessionDir: string, cwd: string, settingsPath: string, home: string
beforeEach(() => {
  script.length = 0
  isReadOnlyCallsAtConstruction.length = 0
  vi.clearAllMocks()
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tdz-sess-'))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tdz-cwd-'))
  memRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tdz-mem-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tdz-home-'))
  process.env.DEEPCODE_TEST_HOME = home
  settingsPath = path.join(cwd, 'flag-settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify({ memory: { enabled: true, dream: { enabled: false } } }))
})
afterEach(() => {
  delete process.env.DEEPCODE_TEST_HOME
  for (const d of [sessionDir, cwd, memRoot, home]) fs.rmSync(d, { recursive: true, force: true })
})

const mkCore = (extra: Record<string, any> = {}) => createChatCore({
  client: {} as any, yolo: true, cwd, sessionDir, flagSettingsPath: settingsPath,
  onState: () => {}, runSubagent: vi.fn(async () => 'ok'), ...extra,
})

describe('Minor 1：isReadOnly 闭包 TDZ 隐雷', () => {
  it('构造期（tools 声明之前）调用 isReadOnly 不抛异常，工具表未回填时按只读处理', async () => {
    const core = mkCore()
    core.dispose()

    expect(isReadOnlyCallsAtConstruction.length).toBeGreaterThan(0)
    for (const call of isReadOnlyCallsAtConstruction) {
      expect(call.threw).toBe(false)
      expect(call.result).toBe(true) // 空表 → ?? true 按只读跳过，而不是 ReferenceError
    }
  })

  it('writer 构造后正常写入日志（未因 TDZ 被置 dead）', async () => {
    const core = mkCore()
    say('干完了')
    await core.send('把这件事办了')
    core.dispose()

    const walk = (d: string): string[] => {
      const out: string[] = []
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) out.push(...walk(f))
        else if (e.name.endsWith('.md')) out.push(f)
      }
      return out
    }
    let files: string[] = []
    try { files = walk(path.join(memRoot, 'logs')) } catch { /* 无日志目录 = 失败 */ }
    expect(files.length).toBe(1)
    const txt = fs.readFileSync(files[0], 'utf8')
    expect(txt).toContain('> 把这件事办了')
    expect(txt).toContain('< 干完了')
  })
})
