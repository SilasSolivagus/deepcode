// test/memory.globalDrawer.e2e.test.ts
// Task 11：全局记忆抽屉端到端验收。
// 北极星：A 项目里说「不喜欢 tailwind」→ B 项目写前端时自动避开，全程不弹窗、不邀功。
// 本文件把前面 10 个任务的成果串成一条链路钉死，独立于各任务自己的单点单测。
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// —— 顶层 mock：三条生产路径（TUI/headless/后台）共用同一脚本化 chatStream，且与开发者机器上
// 真实 ~/.deepcode/settings.json 解耦（不依赖机器上恰好没配置覆盖 memory 字段）——
const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

const mockSettings = { permissions: { allow: [] }, compactTokens: 200_000, costWarnCNY: 15, maxToolResultChars: 100_000 }
vi.mock('../src/config.js', async orig => ({ ...(await orig() as any), loadSettings: vi.fn(() => mockSettings) }))
vi.mock('../src/settingsLayers.js', async orig => ({
  ...(await orig() as any),
  loadLayeredSettings: vi.fn(() => ({
    settings: mockSettings, provenance: {}, permissionSources: { allow: {}, deny: {} }, scopes: [],
  })),
}))
// 防止「三条生产路径」子测试里默认的 runSubagent（提取子代理）真的去调用 client（{} as any 会抛错）
// 或消耗 chatStream 脚本；那几个子测试只关心「初始系统提示是否含全局记忆」，与提取无关。
vi.mock('../src/subagentRunner.js', async orig => ({ ...(await orig() as any), runSubagent: vi.fn(async () => 'ok') }))

import { buildSystemPrompt } from '../src/prompt.js'
import { globalMemdirFor, memdirFor } from '../src/memdir/paths.js'
import { makeMemdirTools } from '../src/services/memory/memdirTools.js'
import { createMemoryExtractor } from '../src/services/memory/extractMemories.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'
import { createChatCore } from '../src/tui/useChat.js'
import * as autoDreamMod from '../src/services/memory/autoDream.js'
import { runHeadless } from '../src/headless.js'
import { runBackgroundSession } from '../src/backgroundRunner.js'
import { newSession } from '../src/session.js'
import { chatStream } from '../src/api.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 10 }
const TW_LINE = '写前端时避开 tailwind。'

describe('全局抽屉端到端', () => {
  let home: string, repoA: string, repoB: string
  beforeEach(() => {
    script.length = 0
    vi.clearAllMocks()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-e2e-'))
    repoA = path.join(home, 'repo-a'); repoB = path.join(home, 'repo-b')
    fs.mkdirSync(path.join(repoA, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repoB, '.git'), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    delete process.env.DEEPCODE_TEST_HOME
  })

  test('A 项目写的全局偏好，在 B 项目的系统提示里全文出现；A 的项目记忆不出现在 B', async () => {
    const gdir = globalMemdirFor(home)
    const toolsA = makeMemdirTools(memdirFor(repoA, home), { globalMemdir: gdir, originKey: '-repo-a' })
    const write = toolsA.find(t => t.name === 'MemWrite')!

    await write.call({ file_path: 'tw.md', content: `---\ntype: user\n---\n${TW_LINE}`, scope: 'global' } as any, {} as any)
    await write.call({ file_path: 'arch.md', content: '---\ntype: project\n---\nA 项目用 pnpm workspace。' } as any, {} as any)

    const promptB = buildSystemPrompt(repoB, home, undefined, undefined, memdirFor(repoB, home), undefined, undefined, undefined, undefined, gdir, 8192)
    expect(promptB).toContain(TW_LINE)               // 全局：跨项目可见
    expect(promptB).not.toContain('pnpm workspace')  // 项目：不泄漏到 B
  })

  test('系统提示带反邀功指令', () => {
    const gdir = globalMemdirFor(home)
    fs.mkdirSync(gdir, { recursive: true })
    fs.writeFileSync(path.join(gdir, 'a.md'), '正文')
    const p = buildSystemPrompt(repoB, home, undefined, undefined, undefined, undefined, undefined, undefined, undefined, gdir, 8192)
    expect(p).toContain('不要在回复里提起')
  })

  test('默认配置（DEFAULT_MEMORY_CONFIG）下不开任何开关，全局记忆仍进系统提示', () => {
    // recall 已退役：静态索引（memdir）恒随 mem.enabled 注入，不再有互斥开关。
    expect(DEFAULT_MEMORY_CONFIG.global.enabled).toBe(true)

    const gdir = globalMemdirFor(home)
    fs.mkdirSync(gdir, { recursive: true })
    fs.writeFileSync(path.join(gdir, 'tw.md'), `---\ntype: user\n---\n${TW_LINE}`)

    // 复刻生产门控逻辑（useChat.ts / headless.ts / backgroundRunner.ts）：
    // 全局抽屉只受 memory.global.enabled 门控；memdir 恒随 mem.enabled 注入。
    const mem = DEFAULT_MEMORY_CONFIG
    const memdir = mem.enabled ? memdirFor(repoB, home) : undefined
    const globalMemdir = mem.enabled && mem.global.enabled ? globalMemdirFor(home) : undefined

    const p = buildSystemPrompt(repoB, home, undefined, undefined, memdir, undefined, undefined, undefined, undefined, globalMemdir, mem.global.maxBytes)
    expect(p).toContain(TW_LINE)
  })

  test('提取 → 注入全链路：真实 createMemoryExtractor + mock LLM 直调 MemWrite 写 scope:global → buildSystemPrompt 读到同一条', async () => {
    // 唯一能证明「写的和读的是同一个抽屉」的测试：不绕过提取器，只 mock 掉 LLM 判断本身，
    // 让 runSubagent 直接调交到它手里的真实 MemWrite 工具（授权/路径隔离/锁全部走真代码）。
    const runSubagent = (async (args: any) => {
      const write = args.tools.find((t: any) => t.name === 'MemWrite')
      await write.call({ file_path: 'tw.md', content: TW_LINE, scope: 'global' }, args.ctx)
      return 'ok'
    }) as any

    const gdir = globalMemdirFor(home)
    const extractor = createMemoryExtractor({
      client: {} as any, memdir: memdirFor(repoA, home),
      globalMemdir: gdir, originKey: '-repo-a',
      config: DEFAULT_MEMORY_CONFIG,
      ctx: { cwd: () => repoA, fileState: new Map(), signal: new AbortController().signal } as any,
      runSubagent, signalGate: async () => true, // 门控本身不是本测试的对象，恒放行
    })
    extractor.onTurnEnd({
      messages: [{ role: 'user', content: '我不喜欢 tailwind，写前端时别用它' }],
      turnIds: [1], maxTurnId: 1,
    })
    await extractor.drain()

    expect(fs.existsSync(path.join(gdir, 'tw.md'))).toBe(true) // 真落进全局抽屉，不是项目抽屉

    const promptB = buildSystemPrompt(repoB, home, undefined, undefined, memdirFor(repoB, home), undefined, undefined, undefined, undefined, gdir, 8192)
    expect(promptB).toContain(TW_LINE)
  })

  test('/pause-memory 全链路：暂停后全局记忆不注入系统提示，恢复后带回', async () => {
    const gdir = globalMemdirFor(home)
    fs.mkdirSync(gdir, { recursive: true })
    fs.writeFileSync(path.join(gdir, 'tw.md'), `---\ntype: user\n---\n${TW_LINE}`)

    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-e2e-sess-'))
    const core = createChatCore({ client: {} as any, yolo: true, cwd: repoB, sessionDir, home, onState: () => {} })
    try {
      await core.send('/pause-memory')
      await core.send('写个前端页面')
      await new Promise(r => setTimeout(r, 30))
      const pausedCall = vi.mocked(chatStream).mock.calls.at(-1)!
      expect(pausedCall[1].messages[0].content).not.toContain(TW_LINE)

      await core.send('/pause-memory')
      await core.send('再写一个')
      await new Promise(r => setTimeout(r, 30))
      const resumedCall = vi.mocked(chatStream).mock.calls.at(-1)!
      expect(resumedCall[1].messages[0].content).toContain(TW_LINE)
    } finally {
      core.dispose()
      dreamSpy.mockRestore()
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  describe('三条生产路径的初始系统提示都带全局抽屉（同一 home，同一条记忆，防个别路径漏接线回归）', () => {
    test('TUI（createChatCore）', async () => {
      const gdir = globalMemdirFor(home)
      fs.mkdirSync(gdir, { recursive: true })
      fs.writeFileSync(path.join(gdir, 'tw.md'), `---\ntype: user\n---\n${TW_LINE}`)
      script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
      const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-e2e-tui-'))
      const core = createChatCore({ client: {} as any, yolo: true, cwd: repoB, sessionDir, home, onState: () => {} })
      try {
        await core.send('写个前端页面')
        await new Promise(r => setTimeout(r, 30))
        const call = vi.mocked(chatStream).mock.calls.at(-1)!
        expect(call[1].messages[0].content).toContain(TW_LINE)
      } finally {
        core.dispose()
        dreamSpy.mockRestore()
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    })

    test('headless（runHeadless / deepcode -p）', async () => {
      const gdir = globalMemdirFor(home)
      fs.mkdirSync(gdir, { recursive: true })
      fs.writeFileSync(path.join(gdir, 'tw.md'), `---\ntype: user\n---\n${TW_LINE}`)
      script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })

      await runHeadless({ client: {} as any, prompt: '写个前端页面', yolo: true, home })

      const call = vi.mocked(chatStream).mock.calls.at(-1)!
      expect(call[1].messages[0].content).toContain(TW_LINE)
    })

    test('后台（runBackgroundSession / /background）', async () => {
      const gdir = globalMemdirFor(home)
      fs.mkdirSync(gdir, { recursive: true })
      fs.writeFileSync(path.join(gdir, 'tw.md'), `---\ntype: user\n---\n${TW_LINE}`)

      // jobStateDir 裸调 os.homedir()（backgroundSession.ts），必须靠此环境变量隔离，否则会写脏
      // 开发者真实 ~/.deepcode/jobs —— 2026-07-13 的教训同类问题，此处显式规避。
      process.env.DEEPCODE_TEST_HOME = home
      const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-e2e-bg-'))
      try {
        const h = newSession({ cwd: repoB, model: 'glm-5.2', thinking: false, permMode: 'default' }, sessDir)
        const short = path.basename(h.file).replace(/\.jsonl$/, '').slice(0, 8)
        script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })

        await runBackgroundSession({ client: {} as any, resumeFile: h.file, jobShort: short, seed: '写个前端页面', home })

        const call = vi.mocked(chatStream).mock.calls.at(-1)!
        expect(call[1].messages[0].content).toContain(TW_LINE)
      } finally {
        delete process.env.DEEPCODE_TEST_HOME
        fs.rmSync(sessDir, { recursive: true, force: true })
      }
    })
  })
})
