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

// Task 1（阶段一 · 抽共享层前的特征测试）：钉住两道「不压缩」守卫，供后续抽取 useChat.ts 主动压缩热路径时当回归网。
// 实读 src/compact.ts:106-134 得出的逐轮推演见 SDD brief；这两条不是 TDD 红灯，一开始就该绿。
describe('特征：快速回填熔断（3b）', () => {
  it('连续超阈值：第 4 轮跳闸不压且注入 thrashing reminder，第 7 轮自愈恢复压缩', async () => {
    // precomputeCompactionEnabled:false → 不 arm/consume，阈值时必走 doCompact('auto') → summarize
    writeSettings({ compactTokens: 20000, precomputeCompactionEnabled: false })
    // Task 9 用例末尾把 summarize 改成了 mockRejectedValue；beforeEach 的 vi.clearAllMocks() 只清
    // calls/results，不清自定义 implementation，会跨用例泄漏。这里显式复位为默认成功实现，
    // 否则本用例前 3 轮 compact 全部失败，第 4 轮会先撞上 3a 连续失败熔断（「已暂停」），
    // 而非本用例要钉的 3b 快速回填熔断（「反复填满」）——两个熔断分支互斥，被抢先的那个会让
    // rapidRefills 因 compacted 从未置 true 而恒为 0，永远走不到目标分支。
    ;(summarize as any).mockResolvedValue({
      summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
    })
    const core = mkCore()

    // 轮 1-3：每轮都超阈值且无旧 tool 可甩（microcompact 返回 null）→ 必走全量
    for (let i = 0; i < 3; i++) {
      script.push({ prompt_tokens: 25000 })
      await core.send(`轮${i + 1}`)
      await new Promise(r => setTimeout(r, 40))
    }
    expect(summarize).toHaveBeenCalledTimes(3)

    // 轮 4：rapidRefills 累到 3 → 跳闸。不压缩、给告警、往 messages 注入 thrashing reminder
    script.push({ prompt_tokens: 25000 })
    await core.send('轮4')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalledTimes(3) // 未新增调用
    expect(hasNotice(core, '反复填满')).toBe(true)

    // 轮 5、6：turnCounter 仍 <3 → 继续跳闸
    for (const n of [5, 6]) {
      script.push({ prompt_tokens: 25000 })
      await core.send(`轮${n}`)
      await new Promise(r => setTimeout(r, 40))
    }
    expect(summarize).toHaveBeenCalledTimes(3)

    // 轮 7：turnCounter 达 3 → checkRapidRefill 归零 → 压缩恢复（无永久 latch）
    script.push({ prompt_tokens: 25000 })
    await core.send('轮7')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalledTimes(4)
    core.dispose()
  })
})

describe('特征：前缀不可压守卫（C1）', () => {
  it('system + 最近 8 条本身已超阈值 → 不调 summarize，给「compaction 帮不上」告警', async () => {
    writeSettings({ compactTokens: 20000, precomputeCompactionEnabled: false })
    // 8 条 HUGE（每条 ≈21000 tok）全部落在 last-COMPACT_KEEP(8) 窗口内 →
    // 不可压前缀（system + 最近 8 条）自身远超 thr=20000 → compaction 帮不上
    script.push({ push: Array.from({ length: 8 }, () => tool(HUGE)), prompt_tokens: 25000 })
    const core = mkCore()
    await core.send('问题')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).not.toHaveBeenCalled()
    expect(hasNotice(core, '帮不上')).toBe(true)
    core.dispose()
  })
})

// Task 2（阶段一 · 抽共享层前的特征测试）：钉住阈值判据与重估机制里另外三处隐式行为——
// 压缩后同轮重估的新基线、precompute arm 带的触发/不触发边界、mc/全量互斥判据的严格小于边界。
describe('特征：压缩后的重估（C3）', () => {
  it('全量压缩后同轮 estimated 用新基线，不沿用压缩前的旧值', async () => {
    // 注意：brief 原始构造用 precomputeCompactionEnabled:false，但 C3 重估（src/tui/useChat.ts:1459）
    // 唯一的读者是紧随其后的 precompute arm 门（1474 行）——关掉 precompute 后这行重估的结果没人读，
    // 对断言零影响，测不出真假（已用「注释掉 1459 行重估」的变异实验验证：关 precompute 时原版两轮断言
    // 依然全绿，说明原始构造是张永远不会红的白纸）。这里改为保持 precompute 默认开启，
    // 并 push 3 条 tool（< microcompact keepRecent=5，mc 不介入、必走全量）使压缩后消息数
    // ≥ PRECOMPUTE_MIN_ARM_LEN(4)，让 arm 门在语法上可达，重估是否生效才有地方体现。
    writeSettings({ compactTokens: 20000 })
    const core = mkCore()
    // estimated=25000 ≥ thr → 全量压缩。压缩把 lastPromptTokens/baselineLen 归零，
    // 同轮末重估 estimated = estimateMessagesTokens(压缩后的全部消息)，远低于 arm 带下沿
    // thr-0.2×thr=16000 → 紧随其后的 arm 门不应触发。
    // 若重估失效（沿用压缩前的旧值 25000），arm 门会误判「仍超 arm 带」，对刚压完的小历史又
    // 后台 arm 一次 → summarize 在同一轮内被调 2 次，用例即红。
    script.push({ push: [small(), small(), small()], prompt_tokens: 25000 })
    await core.send('轮1')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalledTimes(1)
    core.dispose()
  })
})

describe('特征：precompute arm 的触发带', () => {
  it('estimated 进入 arm 带（≥ thr - 0.2×thr）即后台预热；低于该带不预热', async () => {
    writeSettings({ compactTokens: 20000 }) // precompute 默认启用；arm 带下沿 = 20000 - 4000 = 16000
    const core = mkCore()

    // 轮 1：estimated=10000，远低于 arm 带下沿 → 不 arm（summarize 不被调）。
    // push 2 条 tool 把 armLen 垫到 4（=PRECOMPUTE_MIN_ARM_LEN）：若不 push，armLen 只有 2
    // （[system,user1]），会被 arm() 内部「太短不算失败」的兜底guard 挡住——那样即使带下沿判据本身
    // 坏掉，round1 的「不 arm」断言也会碰巧绿（已用「删掉 1475 行的带下沿比较」变异实验验证：
    // 不 push 时该变异对 round1 断言零影响）。push 后 armLen 达标，断言才真正钉住带下沿判据本身。
    script.push({ push: [small(), small()], prompt_tokens: 10000 })
    await core.send('轮1')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).not.toHaveBeenCalled()

    // 轮 2：estimated=17000，落在 [16000, 20000) → 未到压缩阈值但进 arm 带 → 后台预热一次。
    // 同理 push 1 条 tool 把 armLen 垫过 4（PRECOMPUTE_MIN_ARM_LEN）：轮 1 后 messages 已有
    // [system,user1,tool,tool]=4，轮 2 仅 send 追加 user2 → armLen=5，本已达标，这里的 push
    // 是为了保持与轮 1 一致的构造节奏，不是必需——但保留它不影响 estimated=17000（push 发生
    // 在 runLoop mock 内、baselineLen 在 push 之后才采样，这条消息进了 baseline、不计入新增）。
    script.push({ push: [small()], prompt_tokens: 17000 })
    await core.send('轮2')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalledTimes(1)
    core.dispose()
  })
})

describe('特征：microcompact 与全量的互斥边界', () => {
  it('estimated - saved 恰好等于阈值 → 判据是严格小于，故走全量而非 microcompact', async () => {
    writeSettings({ compactTokens: 20000, precomputeCompactionEnabled: false })
    // HUGE≈21000 tok（ceil(70000*0.3)）。布局同用例 (a)：HUGE 落在 last-8 之外，会被 microcompact 甩掉。
    // 实测（用 src/compact.ts 的 microcompact + estimateTextTokens 直接跑同样布局验证，而非仅按注释里的
    // 约数推算）：old=前 4 个 tool（HUGE + 3 条 small），tokensSaved = 21000(HUGE) + 1×3(small) = 21003，
    // 并非 brief 里近似的 21000。要让 estimated - saved 恰好等于 thr=20000，需 estimated = 20000 + 21003 = 41003。
    // 41000（brief 原始建议值）会使 estimated-saved=19997 < thr，反而落进 microcompact 分支——
    // 与本用例要钉的「等于阈值时应走全量」相悖，故按实测把 prompt_tokens 由 41000 调整为 41003。
    script.push({ push: [tool(HUGE), ...Array.from({ length: 8 }, small)], prompt_tokens: 41003 })
    const core = mkCore()
    await core.send('问题')
    await new Promise(r => setTimeout(r, 40))
    expect(summarize).toHaveBeenCalled()
    expect(hasNotice(core, 'microcompact')).toBe(false)
    core.dispose()
  })
})
