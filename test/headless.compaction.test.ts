// headless 的主动压缩挂在 runLoop 的 beforeSend 接缝上——每轮请求发出前判定一次，
// 而不是 drive() 跑完之后。deepcode -p 只有一条用户消息，上下文增长全部发生在
// 那一个 runLoop 的 80-120 轮工具循环里；挂在末尾的话压缩发生时 messages 已经
// 再也不发给 API，只剩抽 final 文本一个消费者（且会把落在 last-8 之外的产出砍掉）。
//
// 隔离同 test/headless.overflow.test.ts（先读过，本仓踩过的坑）：不 mock config.js/
// settingsLayers.js/mcp.js 就会读本机真实 ~/.deepcode/settings.json。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 时序判别式用的全局轨迹：记录「发请求」与「压缩」两类动作的相对顺序。
// 「压没压」这个判别式不够用——第 3/5 条用例的需求在这个维度上互斥（见下方第 5 条注释），
// 只有落在时序上才能同时满足。
const trace: string[] = []

const script: Array<{ result?: any; throw?: Error }> = []
vi.mock('../src/api.js', async orig => {
  const actual = await orig<typeof import('../src/api.js')>()
  return {
    ...actual,
    chatStream: vi.fn(() => {
      trace.push('send')
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      if (scene.throw) throw scene.throw
      return (async function* () { return scene.result })()
    }),
  }
})
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => {
    trace.push('compact')
    return {
      summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
    }
  }),
}))
vi.mock('../src/mcp.js', async orig => {
  const actual = await orig<typeof import('../src/mcp.js')>()
  return { ...actual, initMcpTools: vi.fn(async () => ({ tools: [], cleanup: async () => {} })) }
})

const mockSettings = { permissions: { allow: [] }, compactTokens: 20000, costWarnCNY: 15 }
vi.mock('../src/config.js', async orig => {
  const actual = await orig<typeof import('../src/config.js')>()
  return { ...actual, loadSettings: vi.fn(() => mockSettings) }
})
vi.mock('../src/settingsLayers.js', async orig => {
  const actual = await orig<typeof import('../src/settingsLayers.js')>()
  return {
    ...actual,
    loadLayeredSettings: vi.fn(() => ({
      settings: mockSettings, provenance: {},
      permissionSources: { allow: {}, deny: {} }, scopes: [], strippedDangerousRules: [],
    })),
  }
})

import { runHeadless } from '../src/headless.js'
import { summarize } from '../src/compact.js'

const usage = (pt: number) => ({ prompt_tokens: pt, completion_tokens: 1, prompt_cache_hit_tokens: 0 })
const stop = (content: string, pt: number) => ({
  result: { content, toolCalls: [], usage: usage(pt), finishReason: 'stop' },
})
const home = () => mkdtempSync(path.join(tmpdir(), 'dc-hc-'))
const overflow = () => new Error('This model maximum context length is 128000 tokens')

function smallFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-hc-fixture-'))
  const p = path.join(dir, 'small.txt')
  writeFileSync(p, 'hello\n')
  return p
}

const readTurn = (file: string, i: number, pt: number, content = '') => ({
  result: {
    content, toolCalls: [{ id: `r${i}`, name: 'Read', args: JSON.stringify({ file_path: file }) }],
    usage: usage(pt), finishReason: 'tool_calls',
  },
})

describe('headless 逐轮压缩', () => {
  beforeEach(() => { script.length = 0; trace.length = 0; vi.clearAllMocks() })

  // 立项理由的直接验收：一次 -p 内多轮，压缩发生在【轮间】。
  // 第 1 轮 turn_end 报 25000 ≥ 阈值 20000 → 第 2 轮 beforeSend 就该压。
  it('一次 -p 内多轮 → 轮间触发压缩', async () => {
    const f = smallFile()
    script.push(readTurn(f, 0, 25000))
    script.push(readTurn(f, 1, 25000))
    script.push(stop('完成', 25000))
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('done')
    expect(summarize).toHaveBeenCalled()
  })

  // 单轮就结束时不该压：第 1 轮 beforeSend 时还没有任何 turn_end 观测（基线为 0），
  // 而它结束后就没有下一轮 beforeSend 了。
  it('单轮即结束 → 不压缩', async () => {
    script.push(stop('完成', 25000))
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('done')
    expect(summarize).not.toHaveBeenCalled()
  })

  // 回归网（7e7126c）：drive() 之后不得再压，否则 rebuildMessages 砍掉 last-8 之外的
  // assistant 文本，把「崩溃前的部分产出」抽成空串。
  it('超窗路径 → 保住崩溃前的部分产出', async () => {
    const f = smallFile()
    script.push(readTurn(f, 0, 100, '部分产出'))       // pt 低，不触发轮间压缩
    for (let i = 1; i <= 4; i++) script.push(readTurn(f, i, 100))
    script.push({ throw: overflow() })
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('context_overflow')
    expect(r.text).toBe('部分产出')
    expect(summarize).not.toHaveBeenCalled()
  })

  // M-2 恢复（上一批的必查项）：压缩重新可达后，它的告警必须只落 stderr。
  // 一行中文告警混进 stdout 会让 --output-format json 的下游解析器直接崩。
  it('压缩告警只落 stderr，不污染 stdout 的 json 输出', async () => {
    const out: string[] = []
    const err: string[] = []
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true })
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((s: any) => { err.push(String(s)); return true })
    try {
      const f = smallFile()
      script.push(readTurn(f, 0, 25000))
      script.push(stop('完成', 25000))
      await runHeadless({ client: {} as any, prompt: '干活', yolo: true, outputFormat: 'json', home: home() })
      expect(out.join('')).not.toMatch(/compact|压缩/i)
      // 反向锚点：确认告警确实产生了，不是因为没压缩才没污染
      expect(err.join('')).toMatch(/compact|压缩/i)
    } finally { so.mockRestore(); se.mockRestore() }
  })

  // 回归网（drive() 之后不得压缩），与第 3 条分工不同：第 3 条钉的是「抽 final 逻辑正确」
  // （超窗时不砍产出），这条专门钉「drive() 之后确实没有压缩发生」。
  //
  // 为什么用时序判别式而不是「压没压」：如果直接把 pt 调高逼出压缩，那么最后一轮的
  // beforeSend 必然会先压一次——「summarize 未被调用」这个断言会被合法的轮间压缩带红，
  // 和「drive() 之后不该压」这个诉求在「压没压」这一个维度上互斥，没法同时满足。
  // 换成时序就不冲突：drive() 之后如果被人加回 maybeCompact，它必然发生在最后一次
  // chatStream 发送【之后】，表现为 trace 序列末尾多一个 'compact'；而轮间压缩产生的
  // 'compact' 落在两次 'send' 之间。只看「最后一个动作是不是 send」就能把两者分开。
  it('drive() 之后不得压缩（时序判别，不依赖「压没压」）', async () => {
    const f = smallFile()
    script.push(readTurn(f, 0, 25000)) // 第 1 轮 turn_end 报 25000 ≥ 阈值 → 第 2 轮 beforeSend 会压
    script.push(stop('完成', 25000))
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('done')
    // 反向锚点：轮间确实压了一次，不是因为压根没触发压缩才让下面的断言侥幸通过。
    expect(trace).toContain('compact')
    // 核心断言：序列最后一个动作是发请求，不是压缩。drive() 之后若被加回 maybeCompact，
    // 末尾会多出一个 'compact'，这条就会红。
    expect(trace[trace.length - 1]).toBe('send')
  })
})
