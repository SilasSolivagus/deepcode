// test/useChat.invalidation.test.ts —— 三档作废语义的**调用点级**网
//
// 为什么单开一个文件：manager 单测（test/compactionManager.test.ts）已经钉住了三个方法各自的
// 行为，但没有任何东西钉住「useChat 的哪个入口该调哪一个」。实测过：把 useChat.ts 里
// /rewind 的 clearForRewind() 与 /fork 的 clearPrecompute() **同时**改成 reset()，
// 全量测试仍然全绿——这轮花两个 fix round 挖出来的三档区分，在调用点上是假绿。
// 验收线 test/useChat.compact.test.ts 的 (e)/(f) 只断言「precompute 被作废」，而 reset() 是
// 它的超集，所以退化成 reset 照样绿。本文件补的正是「不许多清」这一侧。
//
// 三档矩阵（manager 侧语义）：
//                  precompute   3b 快速回填计数   token 基线 / 3a 失败计数
//   reset()            清             清                  清
//   clearForRewind()   清             清                  保
//   clearPrecompute()  清             保                  保
// 于是两个可观测量就能把三档两两分开：
//   contextUsed()（= lastPromptTokens）是否归零  → 分开 reset 与另外两个
//   第 4 轮是否触发 3b 跳闸告警                  → 分开 clearForRewind 与 clearPrecompute
//
// 3b 跳闸的构造（见 src/compact.ts:119-135）：每轮都超阈值 → 每轮都 compact → turnCounter 恒 0，
// checkRapidRefill 的 rapidRefills 逐轮 +1（首轮 compacted=false 不算），累到 3 即跳闸。
// 所以「3 轮垫场 → 作废 → 再一轮」正好卡在跳闸边缘：3b 计数留着就跳，被清掉就不跳。
//
// 垫场与作废之间还夹一轮**不过阈值**的 turn，理由是 applyCompactResult 会在每次成功压缩后
// 把 token 基线归零（src/compactionManager.ts:9-11 的边界约定）——不夹这一轮，作废前的
// contextUsed() 本来就是 0，reset() 与另外两档看不出区别。夹的这轮不压缩，于是基线停在
// UNDER；它只让 turnCounter 从 0 变 1，仍 < RAPID_REFILL_LIMIT，不影响后面那轮的跳闸判定。
//
// harness 照抄验收线 test/useChat.compact.test.ts 的顶部（runLoop + summarize 双 mock）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

type Scene = { push?: any[]; prompt_tokens?: number }
const script: Scene[] = []
vi.mock('../src/loop.js', async orig => ({
  ...(await orig() as any),
  runLoop: vi.fn((messages: any[]) =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('runLoop script exhausted')
      if (scene.push) messages.push(...scene.push)
      const sentLen = messages.length
      yield {
        type: 'turn_end',
        usage: { prompt_tokens: scene.prompt_tokens ?? 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
        sentLen,
      }
      return undefined
    })(),
  ),
}))
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({
    summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
  })),
}))

import { createChatCore } from '../src/tui/useChat.js'

const tool = (content: string) => ({ role: 'tool', tool_call_id: 't', content })
const small = () => tool('ok')

let sessionDir: string
let cwd: string
let home: string
let settingsPath: string
beforeEach(() => {
  script.length = 0
  turnSeq = 0
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-inval-session-'))
  cwd = mkdtempSync(path.join(tmpdir(), 'deepcode-inval-cwd-'))
  home = mkdtempSync(path.join(tmpdir(), 'deepcode-inval-home-'))
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
const notices = (core: any) => core.state.transcript.filter((i: any) => i.kind === 'notice').map((i: any) => i.text)
const tripped = (core: any) => notices(core).some((t: string) => t.includes('3 轮内反复填满'))

const OVER = 25000  // ≥ compactTokens=20000，触发全量 compact
const UNDER = 5000  // < 阈值，不压缩：让 token 基线停在非零值供断言

let turnSeq = 0
/** 跑一轮 turn，prompt_tokens 由调用方给定。 */
async function turn(core: any, pt: number) {
  script.push({ push: [small()], prompt_tokens: pt })
  await core.send(`turn${turnSeq++}`)
  await new Promise(r => setTimeout(r, 20))
}
/** 垫场：3 轮超阈值把 3b 的 consecutiveRapidRefills 顶到 2，再夹一轮不过阈值的把 token 基线留在 UNDER。 */
async function fill(core: any) {
  for (let i = 0; i < 3; i++) await turn(core, OVER)
  await turn(core, UNDER)
}

describe('三档作废语义在 useChat 调用点上的区分', () => {
  // 基线：无任何作废动作时，垫场后的下一轮必定跳闸。两条主用例都以此为对照——
  // 它们的区别只在于垫场与末轮之间插了 /rewind 还是 /fork。
  it('基线：垫场后再来一轮超阈值 → 触发 3b 快速回填跳闸', async () => {
    const core = mkCore()
    await fill(core)
    expect(tripped(core)).toBe(false)   // 垫场阶段还没累到 RAPID_REFILL_LIMIT
    expect(core.state.contextUsed()).toBe(UNDER)
    await turn(core, OVER)
    expect(tripped(core)).toBe(true)
    core.dispose()
  })

  it('/rewind → 清 3b 计数（末轮不跳闸），但不清 token 基线', async () => {
    const core = mkCore()
    await fill(core)

    const [{ turnId }] = core.rewindList()
    core.rewind(turnId, 'conversation')

    // 排除 reset()：token 基线是 provider 侧的真实观测值，rewind 改写的是历史线不是它，
    // 归零会让 /context 与页脚占比在 rewind 后凭空掉到 0。
    expect(core.state.contextUsed()).toBe(UNDER)

    // 排除 clearPrecompute()：3b 计数是「上下文反复填满」的跨轮证据，历史线被改写后它不再成立，
    // 留着会让 rewind 后的第一次压缩直接撞上一次不该有的跳闸告警 + 注入 system-reminder。
    await turn(core, OVER)
    expect(tripped(core)).toBe(false)
    core.dispose()
  })

  it('/fork → 只清 precompute：token 基线与 3b 计数都留着（末轮照常跳闸）', async () => {
    const core = mkCore()
    await fill(core)

    await core.send('/fork')

    // 排除 reset()：/fork 把历史逐条拷进新会话，上下文内容不变，压缩基线自然仍然适用。
    expect(core.state.contextUsed()).toBe(UNDER)

    // 排除 clearForRewind()：历史既然原样拷过去，「反复填满」的证据也一并成立——
    // 清掉 3b 等于让用户 /fork 一下就能绕过 thrashing 保护。
    await turn(core, OVER)
    expect(tripped(core)).toBe(true)
    core.dispose()
  })
})
