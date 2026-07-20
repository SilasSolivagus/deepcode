import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createMemoryExtractor } from '../src/services/memory/extractMemories.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

// 隔离真实 provider 配置：断言提取子代理收到的 model 时用哨兵值，不受本机 ~/.deepcode/settings.json 影响。
const FAST_MODEL_SENTINEL = 'sentinel-fast-model'
vi.mock('../src/providers.js', async orig => {
  const actual = await orig() as any
  return { ...actual, activeFastModel: () => FAST_MODEL_SENTINEL }
})

function mkDeps(md: string, runSub: any, cfg = DEFAULT_MEMORY_CONFIG, gate?: (r: any[]) => Promise<boolean>) {
  return {
    client: {} as any, memdir: md, config: cfg,
    ctx: { cwd: () => md, fileState: new Map(), signal: new AbortController().signal } as any,
    runSubagent: runSub,
    scan: async () => [], // 空清单
    signalGate: gate ?? (async () => true), // 默认放行，让既有断言不受门控影响
  }
}

describe('createMemoryExtractor', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ext-')); fs.mkdirSync(md, { recursive: true }) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })

  test('每轮触发（everyTurns=1）调 runSubagent', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).toHaveBeenCalledTimes(1)
  })

  test('游标推进：同 maxTurnId 不重复提取', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    const snap = { messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 }
    ex.onTurnEnd(snap); await ex.drain()
    ex.onTurnEnd(snap); await ex.drain() // 游标已到 1，无新消息
    expect(runSub).toHaveBeenCalledTimes(1)
  })

  test('失败不前移游标，新 turn 重试失败范围', async () => {
    const runSub = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('boom') }) // turn1 失败
      .mockImplementationOnce(async () => 'ok')                         // 重试成功
    const ex = createMemoryExtractor(mkDeps(md, runSub, { ...DEFAULT_MEMORY_CONFIG, extractEveryTurns: 100 }))
    // turn1：失败，cursor 不前移
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    const callsAfterT1 = runSub.mock.calls.length
    expect(callsAfterT1).toBeGreaterThanOrEqual(1) // 至少失败一次
    // turn2：新 maxTurnId，失败范围（turn1）应随新增量一起被重试
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], turnIds: [1, 2], maxTurnId: 2 })
    await ex.drain()
    expect(runSub.mock.calls.length).toBeGreaterThan(callsAfterT1) // 新 turn 确实再次提取（重试）
  })

  test('enabled=false 不触发', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub, { ...DEFAULT_MEMORY_CONFIG, enabled: false }))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).not.toHaveBeenCalled()
  })

  test('信号门控 no → 不唤起子代理，但推进游标', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub, DEFAULT_MEMORY_CONFIG, async () => false))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).not.toHaveBeenCalled() // 门控挡住，不记
    // 游标已推进：同 snap 再来也不会因为"没提取过"而重跑门控唤起子代理
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).not.toHaveBeenCalled()
  })

  test('信号门控 yes → 正常唤起子代理', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub, DEFAULT_MEMORY_CONFIG, async () => true))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).toHaveBeenCalledTimes(1)
  })

  test('drain 跑尾部提取（跳节流）', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub, { ...DEFAULT_MEMORY_CONFIG, extractEveryTurns: 100 }))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 }) // 节流挡住
    expect(runSub).toHaveBeenCalledTimes(0)
    await ex.drain() // 尾部跳节流
    expect(runSub).toHaveBeenCalledTimes(1)
  })

  /** 起提取器，捕获真正交到提取子代理手里的工具集与 userPrompt。 */
  async function handToSubagent(authorize: boolean) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-authz-'))
    const proj = path.join(tmp, 'p'); const glob = path.join(tmp, 'g')
    fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(glob, { recursive: true })
    fs.writeFileSync(path.join(glob, 'tone.md'), '---\nname: tone\ndescription: 说话别绕弯子\ntype: user\n---\n正文')
    let tools: any[] = []; let userPrompt = ''
    const runSubagent = (async (args: any) => { tools = args.tools; userPrompt = args.userPrompt; return { text: '' } }) as any
    const ex = createMemoryExtractor({
      client: {} as any, memdir: proj,
      ...(authorize ? { globalMemdir: glob, originKey: '-repo-a' } : {}),
      config: { ...DEFAULT_MEMORY_CONFIG },
      ctx: { cwd: () => proj, fileState: new Map(), signal: new AbortController().signal } as any,
      runSubagent, signalGate: async () => true,
    } as any)
    ex.onTurnEnd({ messages: [{ role: 'user', content: '不喜欢 tailwind' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    const ctx: any = { cwd: () => proj, fileState: new Map(), signal: new AbortController().signal }
    return { proj, glob, userPrompt, ctx, write: tools.find(t => t.name === 'MemWrite')! }
  }

  test('授权：传了 globalMemdir → 子代理 MemWrite scope:global 真的落进全局抽屉并盖 origin 戳', async () => {
    const { glob, proj, write, ctx } = await handToSubagent(true)
    const out = await write.call({ file_path: 'pref.md', content: '不喜欢 tailwind', scope: 'global' } as any, ctx)
    expect(out).toContain('已写入')
    expect(fs.existsSync(path.join(glob, 'pref.md'))).toBe(true)
    expect(fs.existsSync(path.join(proj, 'pref.md'))).toBe(false)
    expect(fs.readFileSync(path.join(glob, 'pref.md'), 'utf8')).toContain('origin: -repo-a')
  })

  test('未授权：没传 globalMemdir → 子代理 MemWrite scope:global 被硬拒（且不静默落项目抽屉）', async () => {
    const { glob, proj, write, ctx } = await handToSubagent(false)
    const out = await write.call({ file_path: 'pref.md', content: 'x', scope: 'global' } as any, ctx)
    expect(out).toContain('不允许写入全局记忆')
    expect(fs.existsSync(path.join(glob, 'pref.md'))).toBe(false)
    expect(fs.existsSync(path.join(proj, 'pref.md'))).toBe(false)
  })

  test('清单带上全局抽屉的已有条目（身份键前缀 global:）', async () => {
    const { userPrompt } = await handToSubagent(true)
    expect(userPrompt).toContain('global:tone.md')
  })

  test('提取子代理用 fast 档模型（不是主会话模型）', async () => {
    let receivedModel: string | undefined
    const runSub = vi.fn(async (args: any) => { receivedModel = args.model; return 'ok' })
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).toHaveBeenCalledTimes(1)
    expect(receivedModel).toBe(FAST_MODEL_SENTINEL)
  })
})
