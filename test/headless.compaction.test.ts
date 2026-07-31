// test/headless.compaction.test.ts
// headless（跑评测与一切程序化调用的路径）此前全程没有主动上下文压缩：长跑上下文无界累积，
// 而已合入的反应式超窗恢复是单发的——压过一次后本 run 内后续超窗直接返回 context_overflow 收摊。
// 本文件锁住接线后的行为：prompt_tokens 越过阈值时真的调用 summarize 压缩；未越过阈值不压缩；
// 压缩告警（notice）只落 stderr，不污染 --output-format json 的 stdout 输出。
//
// 隔离同 test/headless.overflow.test.ts（先读过，本仓踩过的坑）：不 mock config.js/settingsLayers.js/
// mcp.js 就会读本机真实 ~/.deepcode/settings.json，测试结果会绑死在开发者个人配置上。
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 与 test/headless.overflow.test.ts 同形的脚本桩：每项是一次 chatStream 返回
const script: Array<{ result: any }> = []
vi.mock('../src/api.js', async orig => {
  const actual = await orig<typeof import('../src/api.js')>()
  return {
    ...actual,
    chatStream: vi.fn(() => (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })()),
  }
})
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({
    summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
  })),
}))

let cleanupCalls = 0
vi.mock('../src/mcp.js', async orig => {
  const actual = await orig<typeof import('../src/mcp.js')>()
  return { ...actual, initMcpTools: vi.fn(async () => ({ tools: [], cleanup: async () => { cleanupCalls++ } })) }
})

// 隔离真实设置：照抄 test/headless.overflow.test.ts 的三件套（config.js + settingsLayers.js + mcp.js）。
// compactTokens 设为 20000，让阈值靠脚本里的 usage.prompt_tokens 够得着，不用堆真实大文件。
// 不设 hooks 字段：headless.ts 里 SessionStart/UserPromptSubmit/PreCompact/PostCompact 各处
// 都以 `if (settings.hooks)` 为门，留空即可跳过真实 runHooks，不必再多 mock 一个 hooks.js。
const mockSettings = {
  permissions: { allow: [] },
  compactTokens: 20000,
  costWarnCNY: 15,
}

vi.mock('../src/config.js', async orig => {
  const actual = await orig<typeof import('../src/config.js')>()
  return { ...actual, loadSettings: vi.fn(() => mockSettings) }
})

vi.mock('../src/settingsLayers.js', async orig => {
  const actual = await orig<typeof import('../src/settingsLayers.js')>()
  return {
    ...actual,
    loadLayeredSettings: vi.fn(() => ({
      settings: mockSettings,
      provenance: {},
      permissionSources: { allow: {}, deny: {} },
      scopes: [],
      strippedDangerousRules: [],
    })),
  }
})

import { runHeadless } from '../src/headless.js'
import { summarize } from '../src/compact.js'

const usage = (pt: number) => ({ prompt_tokens: pt, completion_tokens: 1, prompt_cache_hit_tokens: 0 })
const stop = (content: string, pt: number) => ({
  result: { content, toolCalls: [], usage: usage(pt), finishReason: 'stop' },
})

describe('headless 主动压缩', () => {
  beforeEach(() => { script.length = 0; cleanupCalls = 0; vi.clearAllMocks() })

  it('prompt_tokens 越过阈值 → 触发全量压缩', async () => {
    script.push(stop('完成', 25000))   // ≥ mock settings 里的 compactTokens=20000
    await runHeadless({ client: {} as any, prompt: '干活', yolo: true })
    expect(summarize).toHaveBeenCalled()
  })

  it('未过阈值 → 不压缩', async () => {
    script.push(stop('完成', 1000))
    await runHeadless({ client: {} as any, prompt: '干活', yolo: true })
    expect(summarize).not.toHaveBeenCalled()
  })

  it('压缩告警落 stderr，stdout 在 json 输出下仍是合法 JSON', async () => {
    const out: string[] = []
    const err: string[] = []
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true })
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((s: any) => { err.push(String(s)); return true })
    try {
      script.push(stop('完成', 25000))
      const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, outputFormat: 'json' })
      expect(() => JSON.parse(JSON.stringify({ text: r.text, status: r.status }))).not.toThrow()
      // 压缩相关文案只许出现在 stderr
      expect(out.join('')).not.toMatch(/compact|压缩/i)
      // 反向锚点：确认确实触发了压缩（告警真的产生了，不是因为没压缩才没污染 stdout）
      expect(err.join('')).toMatch(/compact|压缩/i)
    } finally { so.mockRestore(); se.mockRestore() }
  })
})
