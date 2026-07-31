// test/useChat.turnSeam.test.ts
// TUI 的主动压缩挂在 runLoop 的 beforeSend 上，粒度是「每轮发送前」而非「回合末」。
// 一次 send 里同样可能跑几十轮工具循环，增长全在轮间。
//
// ⚠️ 与 useChat.compact.test.ts / useChat.compactAbort.test.ts / useChat.invalidation.test.ts
// 的 harness 不同：那三个 mock 掉了 '../src/loop.js'，而本文件要测的行为发生在 runLoop
// 内部，必须 mock 更下层的 chatStream，让真实 runLoop 驱动。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script: Array<{ result: any }> = []
// 每次请求发出时，记录这一发里有没有带上压缩摘要。
// 这是「轮间压缩」最直接的证据：摘要出现在本次 send 的某一发里，
// 就说明压缩发生在 send 内部并且立刻被用上了；只在回合末压的话，
// 本次 send 的每一发都不可能带摘要。
const sawSummary: boolean[] = []
vi.mock('../src/api.js', async orig => {
  const actual = await orig<typeof import('../src/api.js')>()
  return {
    ...actual,
    chatStream: vi.fn((_client: any, opts: any) =>
      (async function* () {
        sawSummary.push(opts.messages.some(
          (m: any) => typeof m.content === 'string' && m.content.includes('<对话历史总结>'),
        ))
        const scene = script.shift()
        if (!scene) throw new Error('script exhausted')
        return scene.result
      })(),
    ),
  }
})
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({
    summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
  })),
}))

import { createChatCore } from '../src/tui/useChat.js'
import { summarize } from '../src/compact.js'

const usage = (pt: number) => ({ prompt_tokens: pt, completion_tokens: 1, prompt_cache_hit_tokens: 0 })

function smallFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-ts-fixture-'))
  const p = path.join(dir, 'small.txt')
  writeFileSync(p, 'hello\n')
  return p
}
const readTurn = (file: string, i: number, pt: number) => ({
  result: {
    content: '', toolCalls: [{ id: `r${i}`, name: 'Read', args: JSON.stringify({ file_path: file }) }],
    usage: usage(pt), finishReason: 'tool_calls',
  },
})
const stopTurn = (pt: number) => ({
  result: { content: '完成', toolCalls: [], usage: usage(pt), finishReason: 'stop' },
})

let sessionDir: string, cwd: string, home: string, settingsPath: string
beforeEach(() => {
  script.length = 0
  sawSummary.length = 0
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-ts-session-'))
  cwd = mkdtempSync(path.join(tmpdir(), 'dc-ts-cwd-'))
  home = mkdtempSync(path.join(tmpdir(), 'dc-ts-home-'))
  settingsPath = path.join(cwd, 'flag-settings.json')
  writeFileSync(settingsPath, JSON.stringify({ compactTokens: 20000, precomputeCompactionEnabled: false }))
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const mkCore = () => createChatCore({
  client: {} as any, yolo: true, cwd, sessionDir, home, flagSettingsPath: settingsPath,
  onState: () => {}, runSubagent: vi.fn(async () => 'ok'),
})

describe('TUI 逐轮压缩', () => {
  it('一次 send 内多轮 → 轮间就压，压缩结果当场用上', async () => {
    const f = smallFile()
    script.push(readTurn(f, 0, 25000))   // 第 1 轮 turn_end 报 25000 ≥ 阈值 20000
    script.push(readTurn(f, 1, 25000))   // → 第 2 轮 beforeSend 压，这一发就该带摘要
    script.push(stopTurn(25000))
    const core = mkCore()
    await core.send('干活')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalled()
    // 第 1 发不可能有摘要（还没压过）；此后至少一发必须带上——
    // 这是压缩发生在 send【内部】的直接证据。只在回合末压的话全是 false。
    expect(sawSummary[0]).toBe(false)
    expect(sawSummary.slice(1).some(Boolean)).toBe(true)
    core.dispose()
  })

  // 边界：单轮 send 里 beforeSend 不该误压（基线还是 0），而回合末那次照常工作。
  // 这条同时钉住「回合末那对调用仍然保留」——删掉它 summarize 就一次都不会被调。
  it('单轮 send → beforeSend 不误压，回合末照常压', async () => {
    script.push(stopTurn(25000))
    const core = mkCore()
    await core.send('干活')
    await new Promise(r => setTimeout(r, 40))
    expect(sawSummary).toEqual([false])          // 本次 send 全程没用上摘要
    expect(summarize).toHaveBeenCalledTimes(1)   // 但回合末确实压了一次
    core.dispose()
  })
})
