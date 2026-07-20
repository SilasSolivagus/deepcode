// test/useChat.memory.test.ts
// Task 11：验证 useChat 每轮末 fire-and-forget 触发记忆提取
// I-2：memory.enabled=false 端到端零副作用验证
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

// subagentRunner 归零，防止消耗 chatStream mock 脚本
vi.mock('../src/subagentRunner.js', async orig => ({
  ...(await orig() as any),
  runSubagent: vi.fn(async () => 'ok'),
}))

// opus 评审 I1：spy 真实实现（不替换行为），只用来断言 5 个构造点的调用参数（globalMemdir/originKey 接线零回归保护）
vi.mock('../src/services/memory/extractMemories.js', async orig => {
  const actual = await orig() as any
  return { ...actual, createMemoryExtractor: vi.fn(actual.createMemoryExtractor) }
})

import { createChatCore } from '../src/tui/useChat.js'
import * as autoDreamMod from '../src/services/memory/autoDream.js'
import * as extractMod from '../src/services/memory/extractMemories.js'
import { clearAllTasks, listTasks } from '../src/tasks.js'
import { chatStream } from '../src/api.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }

let sessionDir: string
let home: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  clearAllTasks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-test-'))
  home = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-home-'))
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('useChat 记忆提取接线', () => {
  it('一轮结束后 extractor.onTurnEnd 触发 runSubagent', async () => {
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    const runSub = vi.fn(async () => 'ok')
    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      home,
      onState: () => {},
      runSubagent: runSub,
    })

    await core.send('hi')

    // onTurnEnd 是 fire-and-forget，flush 微任务让 Promise 链跑完
    await new Promise(r => setTimeout(r, 50))

    expect(runSub).toHaveBeenCalled()
    core.dispose()
  })
})

describe('usageLog kind:memory 计费与过滤', () => {
  it('memory 记录计入 sessionCost，不计入 cacheHitRate/cacheSavings', async () => {
    script.push({
      deltas: ['ok'],
      result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' },
    })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('test')

    // usageLog 已有主对话记录
    const log = core.state.usageLog
    expect(log.length).toBeGreaterThan(0)

    const mainCost = core.state.sessionCost()
    const mainCacheHit = core.state.cacheHitRate()
    const mainSavings = core.state.cacheSavings()

    // 注入一条 kind:'memory' 记录（模拟记忆 fork 推入）
    log.push({ usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 80 }, model: 'deepseek-v4-flash', kind: 'memory' })

    // sessionCost 包含 memory 记录（成本全部可见）
    expect(core.state.sessionCost()).toBeGreaterThan(mainCost)

    // cacheHitRate 不包含 memory 记录（80/100 会极大拉高比率，应保持主对话值）
    expect(core.state.cacheHitRate()).toBeCloseTo(mainCacheHit)

    // cacheSavings 不包含 memory 记录
    expect(core.state.cacheSavings()).toBeCloseTo(mainSavings)

    core.dispose()
  })

  it('只有 memory 记录时 cacheHitRate 返回 0（无主对话 prompt_tokens）', () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    const log = core.state.usageLog
    log.push({ usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 80 }, model: 'deepseek-v4-flash', kind: 'memory' })
    // 无主对话记录，分母为 0 → 返回 0
    expect(core.state.cacheHitRate()).toBe(0)
    core.dispose()
  })
})

describe('useChat memory.enabled=false 端到端零副作用', () => {
  it('disabled 时：subagent 零调用、无 dream 任务、系统提示无记忆索引', async () => {
    // 准备 settings 文件，注入 memory.enabled=false
    const settingsFile = path.join(sessionDir, 'settings-disabled.json')
    writeFileSync(settingsFile, JSON.stringify({ memory: { enabled: false } }))

    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    const runSub = vi.fn(async () => 'ok')
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    let capturedSystemPrompt: string | undefined
    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      home,
      flagSettingsPath: settingsFile,
      onState: () => {},
      runSubagent: runSub,
    })

    // 捕获系统提示（第一条 message 是 system）
    const coreAny = core as any
    // 访问内部 messages 数组需借 send 执行前检查
    // 通过 transcript 后验证 system prompt：直接从 state 消息数组取
    await core.send('hi')
    await new Promise(r => setTimeout(r, 50))

    // ① runSubagent 零调用（提取器和 sessionMemory 都不应触发）
    expect(runSub).not.toHaveBeenCalled()

    // ② 无 dream 任务注册
    const dreamTasks = listTasks().filter(t => t.description.includes('dream'))
    expect(dreamTasks).toHaveLength(0)
    // dreamSpy 也不应被调用（autoDream 整个被 if(mem.enabled) 守卫跳过）
    expect(dreamSpy).not.toHaveBeenCalled()

    // ③ 系统提示不含记忆索引（## 记忆索引 是 loadMemoryPrompt 的固定前缀）
    // 从 transcript 中找 assistant 回复，系统提示在 messages[0].content
    // 通过 /context 斜杠命令验证不可行（非直接），故通过反向推断：
    // 若 memory.enabled=false，memdirFor 不被调用 → buildSystemPrompt 无 memdir → 无 ## 记忆索引
    // 用 vi.spyOn 捕获 buildSystemPrompt 或直接在 session 文件查 system message
    // 最简单：通过 session 文件的第一行（appendMessage(messages[0])）读取
    const sessionFiles = readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'))
    expect(sessionFiles.length).toBeGreaterThan(0)
    const sessionContent = readFileSync(path.join(sessionDir, sessionFiles[0]), 'utf8')
    const firstLine = JSON.parse(sessionContent.split('\n')[0])
    // 第一行是 meta，第二行是 system message
    const secondLine = JSON.parse(sessionContent.split('\n').filter(Boolean)[1])
    expect(secondLine.m?.role).toBe('system')
    capturedSystemPrompt = secondLine.m?.content
    expect(capturedSystemPrompt).toBeDefined()
    expect(capturedSystemPrompt).not.toContain('## 记忆索引')

    dreamSpy.mockRestore()
    core.dispose()
  })
})

describe('useChat 全局记忆抽屉接线', () => {
  it('系统提示里含全局记忆全文', async () => {
    // 在注入的 home 下预置一条全局记忆
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    // M4：中和 runAutoDream，否则 useChat.ts:1269 的 sessionsDir 走裸 os.homedir()，
    // 每跑一次都去扫开发者真实的 ~/.deepcode/sessions（非 hermetic）。
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('hi')
    await new Promise(r => setTimeout(r, 50))

    // 系统提示落到 session 文件第一条消息（meta 之后），从中读回验证
    const sessionFiles = readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'))
    expect(sessionFiles.length).toBeGreaterThan(0)
    const sessionContent = readFileSync(path.join(sessionDir, sessionFiles[0]), 'utf8')
    const secondLine = JSON.parse(sessionContent.split('\n').filter(Boolean)[1])
    expect(secondLine.m?.role).toBe('system')
    expect(secondLine.m?.content).toContain('不喜欢 tailwind。')

    dreamSpy.mockRestore()
    core.dispose()
  })
})

describe('全局抽屉接线回归防护（opus 评审 I1）', () => {
  it('五个 extractor 构造点都传 globalMemdir 与当轮 originKey（初始/​/cd/​/clear/​/fork/resume）', async () => {
    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    const spy = extractMod.createMemoryExtractor as unknown as ReturnType<typeof vi.fn>
    const before = spy.mock.calls.length

    const dirA = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-dirA-'))
    const dirB = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-dirB-'))
    const core = createChatCore({ client: {} as any, yolo: true, cwd: dirA, sessionDir, home, onState: () => {} })
    expect(spy.mock.calls.length).toBe(before + 1) // ① 初始构造

    await core.send('hi')
    await new Promise(r => setTimeout(r, 30))

    await core.send(`/cd ${dirB}`)
    expect(spy.mock.calls.length).toBe(before + 2) // ② /cd 重建

    await core.send('/clear')
    expect(spy.mock.calls.length).toBe(before + 3) // ③ /clear 重建

    await core.send('/fork')
    expect(spy.mock.calls.length).toBe(before + 4) // ④ /fork 重建

    const sessFile = core.sessionFile()!
    core.resume(sessFile)
    expect(spy.mock.calls.length).toBe(before + 5) // ⑤ /resume 重建

    for (const call of spy.mock.calls.slice(before)) {
      const deps = call[0]
      expect(deps.globalMemdir).toBe(path.join(home, '.deepcode', 'memory'))
      expect(deps.originKey).toBeTruthy()
    }

    dreamSpy.mockRestore()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
    core.dispose()
  })

  it('/cd 之后 extractor 的 originKey 重新求值（防 originKey 退化为构造时常量）', async () => {
    const spy = extractMod.createMemoryExtractor as unknown as ReturnType<typeof vi.fn>
    const dirA = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-dirA2-'))
    const dirB = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-dirB2-'))
    const core = createChatCore({ client: {} as any, yolo: true, cwd: dirA, sessionDir, home, onState: () => {} })
    const before = spy.mock.calls.at(-1)![0].originKey

    await core.send(`/cd ${dirB}`)
    const after = spy.mock.calls.at(-1)![0].originKey

    expect(after).not.toBe(before)

    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
    core.dispose()
  })

  it('rebuildSystemPrompt（由 /cd 触发）后系统提示仍含全局记忆全文（防 :2166 漏传新参）', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    const dirA = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-dirA3-'))
    const dirB = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-dirB3-'))
    const core = createChatCore({ client: {} as any, yolo: true, cwd: dirA, sessionDir, home, onState: () => {} })

    await core.send(`/cd ${dirB}`)
    await core.send('hi')
    await new Promise(r => setTimeout(r, 30))

    const call = vi.mocked(chatStream).mock.calls.at(-1)!
    const sysMsg = call[1].messages[0]
    expect(sysMsg.role).toBe('system')
    expect(sysMsg.content).toContain('不喜欢 tailwind。')

    dreamSpy.mockRestore()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
    core.dispose()
  })

  it('/pause-memory 暂停时系统提示不含全局记忆正文，恢复后带回（拦截 chatStream 入参，非读落盘文件）', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })

    await core.send('/pause-memory')
    await core.send('hi')
    await new Promise(r => setTimeout(r, 30))
    const pausedCall = vi.mocked(chatStream).mock.calls.at(-1)!
    expect(pausedCall[1].messages[0].content).not.toContain('不喜欢 tailwind。')

    await core.send('/pause-memory')
    await core.send('hi again')
    await new Promise(r => setTimeout(r, 30))
    const resumedCall = vi.mocked(chatStream).mock.calls.at(-1)!
    expect(resumedCall[1].messages[0].content).toContain('不喜欢 tailwind。')

    dreamSpy.mockRestore()
    core.dispose()
  })

  it('legacy settings 里残留 memory.recall 字段（已退役、被忽略）不影响静态索引恒注入 + 全局段仍在系统提示', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    // 旧版 settings.json 里可能还留着 recall 字段（用户没手动清），parseMemoryConfig 已不再识别它，
    // 应被静默丢弃，不影响 memdir（静态索引）恒随 mem.enabled 注入的新行为。
    const settingsFile = path.join(sessionDir, 'settings-recall.json')
    writeFileSync(settingsFile, JSON.stringify({ memory: { recall: { enabled: true } } }))

    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, flagSettingsPath: settingsFile, onState: () => {} })
    await core.send('hi')
    await new Promise(r => setTimeout(r, 30))

    const call = vi.mocked(chatStream).mock.calls.at(-1)!
    expect(call[1].messages[0].content).toContain('不喜欢 tailwind。')
    expect(call[1].messages[0].content).toContain('## 记忆索引') // 静态索引恒注入（recall 退役后不再有互斥开关）

    dreamSpy.mockRestore()
    core.dispose()
  })
})

describe('resume 强制重建 system prompt（opus 评审 gap：/resume 不刷新全局记忆红线）', () => {
  it('交互 resume() 路径：恢复落盘时不含全局记忆的旧会话后，系统提示含当前全局记忆正文', async () => {
    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    // 会话落盘时全局记忆还不存在
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('hi')
    await new Promise(r => setTimeout(r, 30))
    const file = core.sessionFile()!

    // 「今天」才记下红线（会话恢复前落盘）
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    core.resume(file)
    await core.send('hi again')
    await new Promise(r => setTimeout(r, 30))

    const call = vi.mocked(chatStream).mock.calls.at(-1)!
    expect(call[1].messages[0].content).toContain('不喜欢 tailwind。')

    dreamSpy.mockRestore()
    core.dispose()
  })

  it('冷启动 --resume 路径：进程带 resumeFile 启动时，系统提示含当前全局记忆正文（非落盘旧文本）', async () => {
    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    const dreamSpy = vi.spyOn(autoDreamMod, 'runAutoDream').mockResolvedValue(undefined)

    const first = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await first.send('hi')
    await new Promise(r => setTimeout(r, 30))
    const file = first.sessionFile()!
    first.dispose()

    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    const second = createChatCore({
      client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, resumeFile: file, onState: () => {},
    })
    await second.send('hi again')
    await new Promise(r => setTimeout(r, 30))

    const call = vi.mocked(chatStream).mock.calls.at(-1)!
    expect(call[1].messages[0].content).toContain('不喜欢 tailwind。')

    dreamSpy.mockRestore()
    second.dispose()
  })
})

describe('/memory 命令：分段展示 + rm 删除（用户发现与纠错入口）', () => {
  it('/memory 列出指令文件 + 全局记忆抽屉（含编号/来源/日期）', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\norigin: -repo-a\ncreated: 2026-07-14\ndescription: 不喜欢 tailwind\n---\n不喜欢 tailwind。')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory')

    const notice = (s: string) => expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes(s))).toBe(true)
    notice('全局记忆抽屉')
    notice('[1] tw.md')
    notice('不喜欢 tailwind')
    notice('来自 -repo-a')
    notice('2026-07-14')
    notice('/memory rm')

    core.dispose()
  })

  it('/memory 全局抽屉为空时提示暂无跨项目记忆', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('暂无跨项目记忆'))).toBe(true)
    core.dispose()
  })

  it('/memory rm <编号> <文件名> 匹配时正常删除，且不再出现在下次 /memory 里', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory rm 1 tw.md')

    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('已删除全局记忆') && i.text.includes('tw.md'))).toBe(true)
    expect(existsSync(path.join(globalMemDir, 'tw.md'))).toBe(false)

    await core.send('/memory')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('暂无跨项目记忆'))).toBe(true)

    core.dispose()
  })

  it('/memory rm <不存在编号> <文件名> 给出可见提示，不抛出到主循环', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await expect(core.send('/memory rm 99 x.md')).resolves.not.toThrow()
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('没有编号 99'))).toBe(true)
    core.dispose()
  })

  it('/memory rm（无参数）给出用法提示，而不是退化成展示完整视图', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory rm')
    const last = core.state.transcript.filter(i => i.kind === 'notice').at(-1)
    expect(last?.text).toContain('用法')
    expect(last?.text).toContain('/memory rm <编号> <文件名>')
    // 不应退化成完整视图（不含"指令文件"分段标题）
    expect(last?.text).not.toContain('指令文件（你手写的')
    core.dispose()
  })

  it('/memory rm <编号> <文件名不匹配> → 拒绝删除，提示陈述实际文件名与用户提供文件名的不符', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory rm 1 wrong-name.md')

    const notice = core.state.transcript.find(i => i.kind === 'notice' && (i as any).text?.includes('编号 [1]'))
    expect(notice).toBeDefined()
    expect((notice as any).text).toContain('tw.md')
    expect((notice as any).text).toContain('wrong-name.md')
    expect((notice as any).text).not.toContain('列表已变化')
    // 未删除任何内容
    expect(existsSync(path.join(globalMemDir, 'tw.md'))).toBe(true)

    core.dispose()
  })

  it('竞态核心用例：/memory 展示后台落盘新记忆改变排序，随后按旧编号+旧文件名 rm → 中止且不删除任何东西', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    // 先写较旧的 tailwind.md，再写较新的 contract.md（mtime 降序 → [1] contract.md [2] tailwind.md）
    writeFileSync(path.join(globalMemDir, 'tailwind.md'), '---\ntype: user\n---\n不喜欢 tailwind。')
    await new Promise(r => setTimeout(r, 20))
    writeFileSync(path.join(globalMemDir, 'contract.md'), '---\ntype: user\n---\n误判进全局的客户合同。')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory')
    // 此刻用户看到 [1] contract.md（较新）、[2] tailwind.md（较旧），记下准备删 1 号 contract.md

    // 模拟后台提取子代理在用户敲 rm 之前落盘一条更新的记忆，重排了 mtime 顺序
    await new Promise(r => setTimeout(r, 20))
    writeFileSync(path.join(globalMemDir, 'new-fact.md'), '---\ntype: user\n---\n后台新落盘的事实。')

    // 用户凭上次看到的编号+文件名执行删除
    await core.send('/memory rm 1 contract.md')

    // 断言：中止，且三份文件都还在（尤其 new-fact.md 没被误删）
    const notice = core.state.transcript.find(i => i.kind === 'notice' && i.text.includes('编号 [1]'))
    expect(notice).toBeDefined()
    expect(existsSync(path.join(globalMemDir, 'new-fact.md'))).toBe(true)
    expect(existsSync(path.join(globalMemDir, 'contract.md'))).toBe(true)
    expect(existsSync(path.join(globalMemDir, 'tailwind.md'))).toBe(true)

    core.dispose()
  })

  it('含空格的文件名（如「my note.md」）能被正常删除', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    const spacedFilename = 'my note.md'
    writeFileSync(path.join(globalMemDir, spacedFilename), '---\ntype: user\n---\n一条含空格文件名的记忆。')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send(`/memory rm 1 ${spacedFilename}`)

    // 验证删除成功
    expect(core.state.transcript.some(i => i.kind === 'notice' && (i as any).text?.includes('已删除全局记忆') && (i as any).text?.includes(spacedFilename))).toBe(true)
    expect(existsSync(path.join(globalMemDir, spacedFilename))).toBe(false)

    // 再跑一遍 /memory，文件应该不在
    await core.send('/memory')
    expect(core.state.transcript.some(i => i.kind === 'notice' && (i as any).text?.includes('暂无跨项目记忆'))).toBe(true)

    core.dispose()
  })

  it('含空格文件名 + 多余参数 → 不匹配，拒绝删除（验证 join 效果）', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    const spacedFilename = 'my note.md'
    writeFileSync(path.join(globalMemDir, spacedFilename), '---\ntype: user\n---\n一条含空格文件名的记忆。')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    // 故意加多余参数，文件名就变成 "my note.md extra" 而非 "my note.md"
    await core.send('/memory rm 1 my note.md extra')

    // 验证不匹配提示，包含实际文件名和用户提供的文件名
    const notice = core.state.transcript.find(i => i.kind === 'notice' && (i as any).text?.includes('编号 [1]'))
    expect(notice).toBeDefined()
    expect((notice as any).text).toContain('my note.md')
    expect((notice as any).text).toContain('my note.md extra')

    // 文件还存在
    expect(existsSync(path.join(globalMemDir, spacedFilename))).toBe(true)

    core.dispose()
  })
})

describe('/memory promote：存量记忆升格候选（复制不移动，人工确认）', () => {
  it('没有候选时提示，不抛出', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory promote')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('没有可升格的存量记忆'))).toBe(true)
    core.dispose()
  })

  it('/memory promote 列出 user/feedback 候选（project 类型不出现）', async () => {
    const projMemDir = path.join(home, '.deepcode', 'projects', '-repo-a', 'memory')
    mkdirSync(projMemDir, { recursive: true })
    writeFileSync(path.join(projMemDir, 'pref.md'), '---\ndescription: 不喜欢 tailwind\ntype: user\n---\n正文')
    writeFileSync(path.join(projMemDir, 'arch.md'), '---\ndescription: 本项目架构\ntype: project\n---\n正文')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory promote')

    const notice = core.state.transcript.find(i => i.kind === 'notice' && i.text.includes('pref.md'))
    expect(notice).toBeDefined()
    expect((notice as any).text).toContain('[1]')
    expect((notice as any).text).toContain('-repo-a')
    expect((notice as any).text).not.toContain('arch.md')

    core.dispose()
  })

  it('/memory promote <编号> <文件名> 匹配时复制到全局，源文件保留', async () => {
    const projMemDir = path.join(home, '.deepcode', 'projects', '-repo-a', 'memory')
    mkdirSync(projMemDir, { recursive: true })
    writeFileSync(path.join(projMemDir, 'pref.md'), '---\ndescription: 不喜欢 tailwind\ntype: user\n---\n正文')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory promote 1 pref.md')

    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('已升格') && i.text.includes('pref.md'))).toBe(true)
    expect(existsSync(path.join(home, '.deepcode', 'memory', 'pref.md'))).toBe(true)
    expect(existsSync(path.join(projMemDir, 'pref.md'))).toBe(true) // 源文件保留

    core.dispose()
  })

  it('/memory promote <不存在编号> 给出可见提示，不抛出到主循环', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await expect(core.send('/memory promote 99 x.md')).resolves.not.toThrow()
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('没有编号 99'))).toBe(true)
    core.dispose()
  })

  it('/memory promote（无参数的仅编号）给出用法提示', async () => {
    const projMemDir = path.join(home, '.deepcode', 'projects', '-repo-a', 'memory')
    mkdirSync(projMemDir, { recursive: true })
    writeFileSync(path.join(projMemDir, 'pref.md'), '---\ntype: user\n---\n正文')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory promote 1')
    const last = core.state.transcript.filter(i => i.kind === 'notice').at(-1)
    expect(last?.text).toContain('用法')
    expect(last?.text).toContain('/memory promote <编号> <文件名>')
    core.dispose()
  })

  it('竞态核心用例：候选列表在两次 /memory promote 之间重排 → 编号+文件名不符时中止，不升格任何内容', async () => {
    const projA = path.join(home, '.deepcode', 'projects', '-repo-a', 'memory')
    mkdirSync(projA, { recursive: true })
    writeFileSync(path.join(projA, 'old.md'), '---\ntype: user\n---\n旧的候选。')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory promote')
    // 此刻用户看到 [1] old.md，记下准备升格

    // 模拟另一个项目在此期间新增了一条更新的候选，重排了顺序
    await new Promise(r => setTimeout(r, 20))
    const projB = path.join(home, '.deepcode', 'projects', '-repo-b', 'memory')
    mkdirSync(projB, { recursive: true })
    writeFileSync(path.join(projB, 'new.md'), '---\ntype: user\n---\n后来新增的候选。')

    // 用户凭旧编号 1，但传入错误的文件名（模拟没有重新核对）
    await core.send('/memory promote 1 new.md')

    const notice = core.state.transcript.find(i => i.kind === 'notice' && i.text.includes('编号 [1]'))
    expect(notice).toBeDefined()
    expect((notice as any).text).toContain('未升格任何内容')
    expect(existsSync(path.join(home, '.deepcode', 'memory', 'new.md'))).toBe(false)
    expect(existsSync(path.join(home, '.deepcode', 'memory', 'old.md'))).toBe(false)

    core.dispose()
  })

  it('全局已有同名文件时不覆盖', async () => {
    const projMemDir = path.join(home, '.deepcode', 'projects', '-repo-a', 'memory')
    mkdirSync(projMemDir, { recursive: true })
    writeFileSync(path.join(projMemDir, 'pref.md'), '---\ntype: user\n---\n新内容')
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'pref.md'), '已有内容')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {} })
    await core.send('/memory promote 1 pref.md')

    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('已存在'))).toBe(true)
    expect(readFileSync(path.join(globalMemDir, 'pref.md'), 'utf8')).toBe('已有内容')

    core.dispose()
  })
})

describe('flushMemory：退出前有界 drain 记忆提取（真机冒烟丢记忆根因修复）', () => {
  it('drain 永不 resolve（提取子代理卡死）时，flushMemory 仍在超时后 resolve，不挂死退出', async () => {
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })
    // flushMemory 内部用 EXTRACT_DRAIN_TIMEOUT_MS（数万毫秒级）超时兜底；测试只拦截这个大超时，
    // 缩短到 5ms 真实等待。用 ms >= 20000 判定（不硬编码具体常量值，常量调整不破测试）；
    // 其它 setTimeout（微任务 flush、50ms 等待等）都是小值，原样放行，避免误伤无关计时器。
    const realSetTimeout = global.setTimeout
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((cb: any, ms?: number, ...args: any[]) =>
      (typeof ms === 'number' && ms >= 20000) ? realSetTimeout(cb, 5, ...args) : realSetTimeout(cb, ms, ...args)) as any)

    // runSubagent 永不 resolve：模拟提取子代理在进程被杀前一直卡着
    const runSub = vi.fn(() => new Promise<string>(() => {}))
    const core = createChatCore({
      client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {}, runSubagent: runSub,
    })

    await core.send('hi')
    await new Promise(r => realSetTimeout(r, 50)) // 让 onTurnEnd 触发的 fire-and-forget 提取跑到卡住的 runSubagent 处
    expect(runSub).toHaveBeenCalled()

    const start = Date.now()
    await core.flushMemory()
    expect(Date.now() - start).toBeLessThan(2000) // 缩短后的 5ms 超时应远快于此，留足调度抖动余量

    spy.mockRestore()
    core.dispose()
  })

  it('flushMemory 真的 await 了 drain：drain 未完成前不 resolve，完成后才 resolve', async () => {
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })
    let resolveSub!: (v: string) => void
    const runSub = vi.fn(() => new Promise<string>(res => { resolveSub = res }))
    const core = createChatCore({
      client: {} as any, yolo: true, cwd: '/tmp', sessionDir, home, onState: () => {}, runSubagent: runSub,
    })

    await core.send('hi')
    await new Promise(r => setTimeout(r, 50)) // 让提取跑到卡住的 runSubagent 处
    expect(runSub).toHaveBeenCalled()

    let flushed = false
    const p = core.flushMemory().then(() => { flushed = true })

    // runSubagent 还没 resolve，drain 未完成 → flushMemory 不应该 resolve
    await new Promise(r => setTimeout(r, 50))
    expect(flushed).toBe(false)

    // 提取子代理完成 → drain 跟着完成 → flushMemory 才 resolve
    resolveSub('ok')
    await p
    expect(flushed).toBe(true)

    core.dispose()
  })
})
