// test/useChat.compact.test.ts —— Task 6 端到端接线（mc 互斥 / A2 / breaker / precompute swap / arm gate）
// 通过 createChatCore 集成驱动 runTurn 末端 compact 演进路由。
// 关键 seam：mock '../src/loop.js' 的 runLoop —— 它接收 messages（可 push tool 结果）并 yield turn_end
// （usage.prompt_tokens 直接定 estimated、sentLen 定 baselineLen），从而精确构造上下文状态。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// runLoop 脚本：每次 send 驱动一场。push=本轮 loop 追加进 messages 的消息；usage 定 turn_end。
// throws（Task 8）：push 之后抛该错误（模拟 send 期间 provider 报「上下文超长」）。
type Scene = { push?: any[]; prompt_tokens?: number; throws?: any }
const script: Scene[] = []
vi.mock('../src/loop.js', async orig => ({
  ...(await orig() as any),
  runLoop: vi.fn((messages: any[]) =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('runLoop script exhausted')
      if (scene.push) messages.push(...scene.push)
      if (scene.throws) throw scene.throws // push 后抛：让 catch 里的 microcompact 有旧 tool 可甩
      const sentLen = messages.length // baselineLen = 末尾 → estimated 仅由 prompt_tokens 决定
      yield {
        type: 'turn_end',
        usage: { prompt_tokens: scene.prompt_tokens ?? 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
        sentLen,
      }
      return undefined
    })(),
  ),
}))
// summarize mock：不真打 API；doCompact 与 precompute arm 都走它，供调用次数/入参断言（A2）。
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({
    summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
  })),
}))

import { createChatCore } from '../src/tui/useChat.js'
import { runLoop } from '../src/loop.js'
import { summarize, MICROCOMPACT_PLACEHOLDER } from '../src/compact.js'

// 21000 tok 的旧工具输出（ceil(70000*0.3)）→ 单条即超 mc floor(20000)
const HUGE = 'x'.repeat(70000)
const tool = (content: string) => ({ role: 'tool', tool_call_id: 't', content })
const small = () => tool('ok')

let sessionDir: string
let cwd: string
let home: string
let settingsPath: string
const writeSettings = (obj: any) => writeFileSync(settingsPath, JSON.stringify(obj))
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-compact-session-'))
  cwd = mkdtempSync(path.join(tmpdir(), 'deepcode-compact-cwd-'))
  home = mkdtempSync(path.join(tmpdir(), 'deepcode-compact-home-'))
  settingsPath = path.join(cwd, 'flag-settings.json')
  writeSettings({ compactTokens: 20000 }) // effectiveThreshold=min(171000,20000)=20000
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
const notices = (core: any) => core.state.transcript.filter((i: any) => i.kind === 'notice').map((i: any) => i.text)
const hasNotice = (core: any, sub: string) => notices(core).some((t: string) => t.includes(sub))

describe('Task 6：runTurn 末 compact 演进路由', () => {
  it('(a) microcompact 单独够压 → 不走全量 LLM compact（summarize 不被调，消息瘦身）', async () => {
    // 布局：system, user, HUGE(old tool), 之后 8 条 small tool（HUGE 落在 last-8 之外，C1 守卫不误触）
    // mc：9 个 tool，keepRecent=5 → old=前 4 个，含 HUGE(21000)≥floor → mc 非 null、saved≈21000
    // estimated=prompt_tokens=25000 ≥ thr=20000；estimated-saved≈4000 < thr → mc 单独够 → apply、跳过全量
    script.push({ push: [tool(HUGE), ...Array.from({ length: 8 }, small)], prompt_tokens: 25000 })
    const core = mkCore()
    await core.send('问题')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).not.toHaveBeenCalled()
    expect(hasNotice(core, 'microcompact')).toBe(true)
    core.dispose()
  })

  it('(b) 【A2】microcompact 不够 → 走全量 compact，且 summarize 收到【原文】非占位符消息', async () => {
    // 同布局但 estimated=50000：estimated-saved≈29000 ≥ thr=20000 → mc 不够 → 弃 mc、对原始 messages 全量
    script.push({ push: [tool(HUGE), ...Array.from({ length: 8 }, small)], prompt_tokens: 50000 })
    const core = mkCore()
    await core.send('问题')
    await new Promise(r => setTimeout(r, 40))
    // 第 1 次 = 全量 doCompact 的 summarize（后续可能再 arm，故只锁定首调）
    expect(summarize).toHaveBeenCalled()
    // A2 验证：summarize 入参 messages 仍含 HUGE 原文，绝无占位符化
    const passed = (summarize as any).mock.calls[0][1] as any[]
    expect(passed.some(m => m.content === HUGE)).toBe(true)
    expect(passed.some(m => m.content === MICROCOMPACT_PLACEHOLDER)).toBe(false)
    core.dispose()
  })

  it('(c) precompute 命中 → swap（summarize 在 arm 时后台调，阈值时不再阻塞新调）', async () => {
    // send1：estimated=18000 落在 arm 带 [0.8thr,thr)=[16000,20000)，未触发 compact → arm 后台 summarize
    script.push({ push: [small(), small()], prompt_tokens: 18000 })
    const core = mkCore()
    await core.send('轮1')
    await new Promise(r => setTimeout(r, 40)) // 等后台 arm summarize settle → ready
    expect(summarize).toHaveBeenCalledTimes(1) // arm 调了一次
    // send2：estimated=25000 ≥ thr → consume ready → swap（无新 summarize）
    script.push({ push: [small()], prompt_tokens: 25000 })
    await core.send('轮2')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalledTimes(1) // swap 未再调 summarize（预算已在 arm 完成）
    expect(hasNotice(core, 'precompute')).toBe(true)
    core.dispose()
  })

  it('(d) precomputeCompactionEnabled:false → 不 arm，阈值时退回全量 compact', async () => {
    writeSettings({ compactTokens: 20000, precomputeCompactionEnabled: false })
    // send1：arm 带内但关闭 → 不 arm → summarize 不被调
    script.push({ push: [small(), small()], prompt_tokens: 18000 })
    const core = mkCore()
    await core.send('轮1')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).not.toHaveBeenCalled()
    // send2：阈值 → 无预算可消费 → 退回 doCompact 全量 → summarize 调一次
    script.push({ push: [small()], prompt_tokens: 25000 })
    await core.send('轮2')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalledTimes(1)
    core.dispose()
  })

  it('(e)【A1】/rewind 后 precompute entry 作废，不 swap 坏摘要', async () => {
    // turn1：[system,userA,tool,tool] armLen=4，estimated=18000 落 arm 带 → arm 后台 summarize（→ ready）
    script.push({ push: [small(), small()], prompt_tokens: 18000 })
    const core = mkCore()
    await core.send('A')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalledTimes(1) // arm 调了一次

    // rewind 回退到 turn1 之前：messages 截回只剩 system，armLen(4) 快照与其后的新历史不同源
    const [{ turnId }] = core.rewindList()
    core.rewind(turnId, 'conversation')

    // turn2：重新长回到同样长度 4（[system,userC,tool,tool]）但内容完全不同——
    // 若未 clear，consume() 纯计数式陈旧检测（armLen>length / tail token）测不出这种「shrink 后重长回同长度」
    // 的错位，会误把 turn1 的旧摘要 swap 进这条全新历史线（A1 坏上下文）
    script.push({ push: [small(), small()], prompt_tokens: 25000 })
    await core.send('C')
    await new Promise(r => setTimeout(r, 40))

    // 断言：走的是全量 doCompact（summarize 第二次被调），不是 swap
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(hasNotice(core, 'precompute')).toBe(false)
    core.dispose()
  })

  it('(f)【A1】/resume 切到不同会话后 precompute entry 作废，不 swap 坏摘要', async () => {
    // turn1（会话1）：[system,userA,tool,tool] armLen=4，estimated=18000 落 arm 带 → arm 后台 summarize（→ ready）
    script.push({ push: [small(), small()], prompt_tokens: 18000 })
    const core = mkCore()
    await core.send('A')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalledTimes(1) // arm 调了一次，entry ready，armLen=4

    // 手写会话2 的 jsonl：同样 4 条消息（system+user+tool+tool）但内容完全不同——
    // messages.length(4) 不小于 armLen(4) 且尾部 messages.slice(4)=[] 为空，
    // 纯计数式陈旧检测（consume() 的 armLen>length / tailTokens>=thr）测不出这种「换会话但长度/尾部都不触发」
    // 的错位，若 restoreSession 不 clear，会把会话1 的旧摘要 swap 进会话2 的全新历史（A1 坏上下文）
    const session2 = path.join(sessionDir, 'session2.jsonl')
    const lines = [
      { t: 'meta', cwd, model: 'deepseek-v4-flash', thinking: false, permMode: 'default' },
      { t: 'msg', m: { role: 'system', content: 'sys2' } },
      { t: 'msg', m: { role: 'user', content: 'D' } },
      { t: 'msg', m: { role: 'tool', tool_call_id: 't', content: 'ok2' } },
      { t: 'msg', m: { role: 'tool', tool_call_id: 't', content: 'ok3' } },
    ]
    writeFileSync(session2, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    core.resume(session2)

    // turn2（会话2）：estimated=25000 ≥ thr=20000
    script.push({ push: [small()], prompt_tokens: 25000 })
    await core.send('E')
    await new Promise(r => setTimeout(r, 40))

    // 断言：走的是全量 doCompact（summarize 第二次被调），不是 swap 会话1 的旧摘要
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(hasNotice(core, 'precompute')).toBe(false)
    core.dispose()
  })
})

describe('Task 8：反应式 overflow 兜底（send overflow → microcompact + 重试一次）', () => {
  it('send 遇上下文超长错误 → microcompact + 重试一次（可甩时）', async () => {
    const overflow = Object.assign(new Error('context length exceeded'), { code: 'context_length_exceeded' })
    // scene1：先 push 大量旧 tool（HUGE 可甩）再抛 overflow；scene2：正常返回收尾
    script.push({ push: [tool(HUGE), ...Array.from({ length: 8 }, small)], throws: overflow })
    script.push({ push: [small()], prompt_tokens: 5000 })
    const core = mkCore()
    await core.send('问题')
    await new Promise(r => setTimeout(r, 40))
    expect(runLoop).toHaveBeenCalledTimes(2)                // runLoop 被驱动两次（原始 + 重试）
    expect(hasNotice(core, 'microcompact 甩掉')).toBe(true)  // mc 生效（消息瘦身）
    expect(hasNotice(core, '[错误]')).toBe(false)            // 无最终错误冒泡
    core.dispose()
  })

  it('mc 无可甩时不重试，照常报错', async () => {
    const overflow = Object.assign(new Error('context_length_exceeded'), { code: 'context_length_exceeded' })
    script.push({ throws: overflow }) // 无旧 tool 结果 → microcompact 返回 null
    const core = mkCore()
    await core.send('问题')
    await new Promise(r => setTimeout(r, 40))
    expect(runLoop).toHaveBeenCalledTimes(1) // 不重试（单发，无死循环）
    expect(hasNotice(core, '[错误]')).toBe(true) // 走原错误分支
    core.dispose()
  })
})

describe('Task 9【3a】：连续失败熔断后不再尝试全量 compact', () => {
  it('连续 3 次全量 compact 失败后跳闸「已暂停」→ 第 4 轮不再调用 summarize（熔断生效）', async () => {
    // precomputeCompactionEnabled:false → 不 arm/consume，阈值时必走 doCompact('auto') → summarize
    writeSettings({ compactTokens: 20000, precomputeCompactionEnabled: false })
    // 无旧 tool 消息 → microcompact 恒返回 null（tokensSaved=0 < floor）→ 必然落到 doCompact 分支
    ;(summarize as any).mockRejectedValue(new Error('summarize boom'))
    const core = mkCore()

    // 3 轮：每轮 estimated=25000 ≥ thr=20000，doCompact 抛错 → consecutiveCompactFailures 1→2→3
    for (let i = 0; i < 3; i++) {
      script.push({ prompt_tokens: 25000 })
      await core.send(`轮${i + 1}`)
      await new Promise(r => setTimeout(r, 40))
    }
    expect(summarize).toHaveBeenCalledTimes(3)
    expect(hasNotice(core, '已暂停')).toBe(true) // 第 3 次触发熔断告警

    const noticeCountBefore = notices(core).length

    // 第 4 轮：estimated 仍 ≥ thr，但熔断已跳闸 → 3a 分支静默跳过，不再调用 summarize
    script.push({ prompt_tokens: 25000 })
    await core.send('轮4')
    await new Promise(r => setTimeout(r, 40))

    expect(summarize).toHaveBeenCalledTimes(3) // 未被第 4 次调用
    expect(notices(core).length).toBe(noticeCountBefore) // 无新告警（静默跳过，不重复「已暂停」/「失败」）
    core.dispose()
  })
})
