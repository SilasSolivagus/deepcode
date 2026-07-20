// test/tui.useChat.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 隔离真实 provider 配置：pinning activeProvider/activeFastModel 为 deepseek 档，
// 使测试对 ~/.deepcode/settings.json 中 provider:glm 免疫（/model 切换、rotateModel 等依赖此）。
vi.mock('../src/providers.js', async orig => {
  const actual = await orig() as any
  const deepseekPreset = actual.BUILTIN_PROVIDERS.deepseek
  return {
    ...actual,
    activeProvider: () => deepseekPreset,
    activeFastModel: () => 'deepseek-v4-flash',
    activeSmartModel: () => 'deepseek-v4-pro',
    belongsToProvider: (preset: any, modelId: string) => actual.belongsToProvider(deepseekPreset, modelId),
  }
})

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

// 隔离宿主机 ~/.deepcode/settings.json 的权限规则：钉空 permissions.allow/deny，
// 使权限测试（ask-chain 等）不受用户累积的 allow 规则影响（如 Bash(echo hello:*) 会让 ask 不弹 → 测试挂死）。
vi.mock('../src/settingsLayers.js', async orig => {
  const actual = (await orig()) as any
  return {
    ...actual,
    loadLayeredSettings: (cwd: string, flagPath?: string) => {
      const real = actual.loadLayeredSettings(cwd, flagPath)
      return {
        ...real,
        // memory.enabled=false：禁掉每轮末 fire-and-forget 的提取/dream（本文件无测试依赖之），
        // 避免 mock 脚本耗尽时的 "[memory] 提取失败" 噪音与测试结束后晚到的 console.error→write EPIPE。
        settings: { ...real.settings, permissions: { allow: [], deny: [] }, memory: { ...real.settings.memory, enabled: false } },
        permissionSources: { allow: {}, deny: {} },
      }
    },
  }
})

// emitNotification 真写 /dev/tty（OSC/BEL 转义序列 + 真实终端响铃/桌面通知）；权限 ask 链路测试
// 会真实触发它，污染测试输出且实际发通知。mock 为 no-op，保留其余导出（makeIdleNotifier 等）真实。
vi.mock('../src/notify.js', async importOriginal => {
  const orig = await importOriginal() as any
  return { ...orig, emitNotification: () => {} }
})

import { transcriptReducer, displayTextOf, type TranscriptItem, createChatCore } from '../src/tui/useChat.js'
import { newFlushState, computeFlush } from '../src/tui/messageDisplayFlush.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }

let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  // 每个测试独立的 session 目录，防止写入 ~/.deepcode/sessions
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-test-'))
})

describe('transcriptReducer', () => {
  it('text delta 追加到进行中 assistant 块；reasoning delta 进思考块', () => {
    let s = transcriptReducer([], { type: 'delta', delta: '你', reasoning: false, messageId: 'm1' })
    s = transcriptReducer(s, { type: 'delta', delta: '好', reasoning: false, messageId: 'm1' })
    s = transcriptReducer(s, { type: 'delta', delta: '思', reasoning: true, messageId: 'm1' })
    expect(displayTextOf(s.find(i => i.kind === 'assistant' && !i.done) as any)).toBe('你好')
    expect(displayTextOf(s.find(i => i.kind === 'reasoning' && !i.done) as any)).toBe('思')
  })

  it('tool_start 插入运行中工具行，tool_end 标记完成并带耗时', () => {
    let s = transcriptReducer([], { type: 'tool_start', id: 't1', name: 'Read', desc: '{"file_path":"a.ts"}' })
    expect((s.at(-1) as any).running).toBe(true)
    s = transcriptReducer(s, { type: 'tool_end', id: 't1', ok: true, preview: '1  // a', previewExtra: 0, ms: 120 })
    const t = s.find(i => i.kind === 'tool' && (i as any).id === 't1') as any
    expect(t.running).toBe(false)
    expect(t.ms).toBe(120)
  })

  it('turn_end 关闭进行中块并追加 usage 行', () => {
    let s = transcriptReducer([], { type: 'delta', delta: 'x', reasoning: false, messageId: 'm1' })
    s = transcriptReducer(s, { type: 'turn_end', usage })
    expect(s.every(i => i.kind !== 'assistant' || i.done)).toBe(true)
    expect(s.at(-1)!.kind).toBe('usage')
  })

  it('seal 关闭所有进行中块并丢弃空文本块', () => {
    // 一个有内容的进行中块 + 一个空的进行中块
    let s = transcriptReducer([], { type: 'delta', delta: '内容', reasoning: false, messageId: 'm1' })
    s = [...s, { kind: 'assistant' as const, segments: [], pending: '', messageId: 'm2', done: false }]
    s = transcriptReducer(s, { type: 'seal' })
    // 有内容的块应保留且 done=true
    expect(s.some(i => i.kind === 'assistant' && (i as any).done && displayTextOf(i as any) === '内容')).toBe(true)
    // 空文本块应被丢弃
    expect(s.filter(i => i.kind === 'assistant' && displayTextOf(i as any) === '').length).toBe(0)
    // 所有 assistant 块都 done
    expect(s.every(i => i.kind !== 'assistant' || (i as any).done)).toBe(true)
  })
})

describe('批B Task2: segment reducer', () => {
  const d = (delta: string, messageId = 'm1', reasoning = false) => ({ type: 'delta' as const, delta, messageId, reasoning })
  it('delta 追加进 pending，displayTextOf 还原全文', () => {
    let s = transcriptReducer([], d('hel'))
    s = transcriptReducer(s, d('lo\nwor'))
    expect(s[0].kind).toBe('assistant')
    expect(displayTextOf(s[0] as any)).toBe('hello\nwor')
    expect((s[0] as any).messageId).toBe('m1')
  })
  it('close_segment 把完成行封成 segment、pending 去头', () => {
    let s = transcriptReducer([], d('hello\nwor'))
    s = transcriptReducer(s, { type: 'close_segment', messageId: 'm1', orig: 'hello\n' })
    expect((s[0] as any).segments).toEqual([{ orig: 'hello\n' }])
    expect((s[0] as any).pending).toBe('wor')
    expect(displayTextOf(s[0] as any)).toBe('hello\nwor') // 显示不变
  })
  it('patch_segment 替换 segment.shown（不动 pending/存档）', () => {
    let s = transcriptReducer([], d('hello\n'))
    s = transcriptReducer(s, { type: 'close_segment', messageId: 'm1', orig: 'hello\n' })
    s = transcriptReducer(s, { type: 'patch_segment', messageId: 'm1', index: 0, shown: 'HELLO\n' })
    expect(displayTextOf(s[0] as any)).toBe('HELLO\n')
    expect((s[0] as any).segments[0].orig).toBe('hello\n') // orig 保留
  })
  it('patch_segment 找不到 messageId → no-op（不抛）', () => {
    let s = transcriptReducer([], d('x'))
    const before = s
    s = transcriptReducer(s, { type: 'patch_segment', messageId: 'nope', index: 0, shown: 'Y' })
    expect(s).toEqual(before)
  })
  it('seal 空判用 displayTextOf（空块丢弃）', () => {
    let s = transcriptReducer([], d('', 'm2'))       // 空 delta 开块
    s = transcriptReducer(s, { type: 'seal' })
    expect(s.filter(i => i.kind === 'assistant')).toHaveLength(0)
  })
})

it('批B Task4: flush 序列 + reducer 组合（含 patch 替换）', () => {
  const st = newFlushState('m1', 0)
  let s = transcriptReducer([], { type: 'delta', delta: '', reasoning: false, messageId: 'm1' })
  // 段1: "L1\n" 到达，1s 后 flush
  st.rawText = 'L1\n'
  s = transcriptReducer(s, { type: 'delta', delta: 'L1\n', reasoning: false, messageId: 'm1' })
  let r = computeFlush(st, 1000, false) as { deltaText: string; index: number; end: number }
  expect(r.deltaText).toBe('L1\n'); expect(r.index).toBe(0)
  st.flushedOffset = r.end; st.index++; st.lastFlushAt = 1000
  s = transcriptReducer(s, { type: 'close_segment', messageId: 'm1', orig: r.deltaText })
  // hook 替换段0
  s = transcriptReducer(s, { type: 'patch_segment', messageId: 'm1', index: 0, shown: '★L1★\n' })
  expect(displayTextOf(s[0] as any)).toBe('★L1★\n')
  // 段2: 追加未完成 "L2partial"
  st.rawText += 'L2partial'
  s = transcriptReducer(s, { type: 'delta', delta: 'L2partial', reasoning: false, messageId: 'm1' })
  expect(computeFlush(st, 3000, false)).toBeNull() // 无新完成行
  // final: 冲刷剩余
  r = computeFlush(st, 3000, true) as { deltaText: string; index: number; end: number }
  expect(r.deltaText).toBe('L2partial')
  s = transcriptReducer(s, { type: 'close_segment', messageId: 'm1', orig: r.deltaText })
  expect(displayTextOf(s[0] as any)).toBe('★L1★\nL2partial')
})

describe('批B Task4 回归: turn_end/seal 必须晚于 close_segment，否则 patch 丢失', () => {
  const asst = (s: TranscriptItem[]) => s.find(i => i.kind === 'assistant') as any
  it('错误顺序（先 turn_end 封块再 close_segment）：段落丢失，patch 的 displayContent 替换被静默丢弃', () => {
    let s = transcriptReducer([], { type: 'delta', delta: 'hello', reasoning: false, messageId: 'm1' })
    // 复现 bug：turn_end 先把块 seal（done:true），mdEndBlock 才 dispatch close_segment
    s = transcriptReducer(s, { type: 'turn_end', usage })
    s = transcriptReducer(s, { type: 'close_segment', messageId: 'm1', orig: 'hello' }) // !it.done 守卫 → no-op
    expect(asst(s).segments).toEqual([]) // 段落没建立
    s = transcriptReducer(s, { type: 'patch_segment', messageId: 'm1', index: 0, shown: 'HELLO' }) // index 越界 → no-op
    expect(displayTextOf(asst(s))).toBe('hello') // 替换丢失：仍是原文，未被 patch
  })
  it('正确顺序（先 close_segment 再 turn_end/seal）：段落建立，displayContent 替换在已 seal 的块上依然生效', () => {
    let s = transcriptReducer([], { type: 'delta', delta: 'hello', reasoning: false, messageId: 'm2' })
    s = transcriptReducer(s, { type: 'close_segment', messageId: 'm2', orig: 'hello' }) // 段落在 seal 前建立
    s = transcriptReducer(s, { type: 'turn_end', usage }) // 现在才 seal（done:true）
    expect(asst(s).done).toBe(true)
    s = transcriptReducer(s, { type: 'patch_segment', messageId: 'm2', index: 0, shown: 'HELLO' }) // patch 不看 done，仍生效
    expect(displayTextOf(asst(s))).toBe('HELLO') // 替换保住
  })
})

describe('createChatCore.runTurn', () => {
  it('初始 state 含 turnStartAt=null、turnOutTokens=0（spinner 数据契约）', () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    expect(core.state.turnStartAt).toBeNull()
    expect(core.state.turnOutTokens).toBe(0)
  })

  it('一轮结束后 turnStartAt 复位为 null，turnOutTokens 为真实输出 token', async () => {
    script.push(
      { deltas: ['好', '的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('随便说点')
    expect(core.state.turnStartAt).toBeNull()
    expect(core.state.turnOutTokens).toBe(usage.completion_tokens)
  })

  it('完整一轮：脚本驱动事件流，状态可被订阅者观察，usage 落 usageLog', async () => {
    script.push(
      { deltas: ['好', '的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const frames: TranscriptItem[][] = []
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: s => frames.push(s.transcript) })
    await core.send('随便说点')
    const last = frames.at(-1)!
    expect(last.some(i => i.kind === 'user' && i.text === '随便说点')).toBe(true)
    expect(last.some(i => i.kind === 'assistant' && i.done && displayTextOf(i) === '好的')).toBe(true)
    expect(core.state.usageLog.length).toBe(1)
    expect(core.state.cacheHitRate()).toBeCloseTo(40 / 50)
  })

  it('新建会话 contextPct() 为 0', () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    expect(core.state.contextPct()).toBe(0)
  })

  it('斜杠命令 /cost /clear 走本地语义不发请求', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('/cost')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('本会话'))).toBe(true)
    await core.send('/clear')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('已清空'))).toBe(true)
    expect((await import('../src/api.js') as any).chatStream.mock.calls.length).toBe(0)
  })

  it('Esc 中断：abort 后 transcript 出现中断 notice', async () => {
    script.push({
      deltas: ['长', '回', '答'],
      result: { content: '长回答', toolCalls: [], usage, finishReason: 'stop' },
    })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    const p = core.send('说个长的')
    core.interrupt() // chatStream mock 不感知 signal——这里验证 interrupt 不抛、状态机不卡死
    await p
    expect(core.state.busy).toBe(false)
  })

  // ── Fix 4a: ask-chain ──────────────────────────────────────────────────────
  it('ask-chain: 权限拒绝后工具结果含拒绝原因，最终 busy=false', async () => {
    // 第一次 chatStream: 返回 Bash 工具调用
    script.push({
      deltas: [],
      result: {
        content: '',
        toolCalls: [{ id: 'tc1', name: 'Bash', args: '{"command":"echo hello"}' }],
        usage,
        finishReason: 'tool_calls',
      },
    })
    // 第二次 chatStream: 模型收到拒绝结果后的回复（loop 内第二轮）
    script.push({
      deltas: ['好的，已取消。'],
      result: { content: '好的，已取消。', toolCalls: [], usage, finishReason: 'stop' },
    })

    const states: any[] = []
    // 非 yolo 模式，Bash 工具需要权限确认
    const core = createChatCore({ client: {} as any, yolo: false, cwd: '/tmp', sessionDir, onState: s => states.push(s) })

    // 等待 pendingAsk 被设置（轮询 onState 帧）
    const pendingAskSet = new Promise<void>(resolve => {
      const unsub = core.subscribe(() => {
        if (core.state.pendingAsk) { unsub(); resolve() }
      })
    })

    const sendP = core.send('请执行命令')
    await pendingAskSet

    // 确认 pendingAsk 存在
    expect(core.state.pendingAsk).not.toBeNull()
    expect(core.state.pendingAsk!.toolName).toBe('Bash')

    // 拒绝操作
    core.resolveAsk('no')

    await sendP
    expect(core.state.busy).toBe(false)

    // transcript 中的工具 end 项 preview 应包含拒绝理由
    const toolItems = core.state.transcript.filter(i => i.kind === 'tool') as any[]
    expect(toolItems.length).toBeGreaterThan(0)
    expect(toolItems.some(t => t.preview?.includes('用户拒绝了此操作'))).toBe(true)
  })

  // ── Fix 4b: interrupt-during-ask (C1 regression test) ────────────────────
  it('interrupt-during-ask: interrupt 时 pendingAsk 不为 null，send Promise 正常 resolve', async () => {
    // 第一次 chatStream: 返回 Bash 工具调用，触发权限弹窗
    script.push({
      deltas: [],
      result: {
        content: '',
        toolCalls: [{ id: 'tc2', name: 'Bash', args: '{"command":"rm -rf /"}' }],
        usage,
        finishReason: 'tool_calls',
      },
    })
    // 注意：interrupt 后 loop 因 abort 提前返回，不需要第二个 scene

    const core = createChatCore({ client: {} as any, yolo: false, cwd: '/tmp', sessionDir, onState: () => {} })

    // 等待 pendingAsk 被设置
    const pendingAskSet = new Promise<void>(resolve => {
      const unsub = core.subscribe(() => {
        if (core.state.pendingAsk) { unsub(); resolve() }
      })
    })

    const sendP = core.send('危险操作')
    await pendingAskSet

    // pendingAsk 此时非 null，这是 C1 deadlock 场景
    expect(core.state.pendingAsk).not.toBeNull()

    // interrupt 应同时解除 pendingAsk 并 abort（Fix 1 防止死锁）
    core.interrupt()

    // send Promise 必须 resolve（没有 Fix 1 时此处会永远 hang）
    await sendP

    expect(core.state.busy).toBe(false)
    expect(core.state.pendingAsk).toBeNull()
  })

  // ── Task 10: /model 参数化 ────────────────────────────────────────────────
  it('/model <名> 切换到任意模型，notice 含 已切换到；非当前 provider 档加兜底提示', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('/model my-custom-model')
    expect(core.state.model).toBe('my-custom-model')
    const notices = core.state.transcript.filter(i => i.kind === 'notice') as any[]
    expect(notices.some(n => n.text.includes('已切换到') && n.text.includes('my-custom-model'))).toBe(true)
    expect(notices.some(n => n.text.includes('非当前 provider 档，计价/上下文按兜底估算'))).toBe(true)
  })

  it('/model 无参从自定义模型切回 flash', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    // 先切到自定义模型
    await core.send('/model my-custom-model')
    expect(core.state.model).toBe('my-custom-model')
    // 裸 /model 应切回 flash（从自定义模型落到 flash）
    await core.send('/model')
    expect(core.state.model).toBe('deepseek-v4-flash')
  })

  // ── Fix 4c: seal — chatStream 抛出时没有 done=false 残留块 ─────────────────
  it('seal: chatStream 抛出后无 done=false 残留块，第二次回复为独立条目', async () => {
    // 第一次：无 scene → chatStream 抛出 'script exhausted'
    // 不推任何 scene

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })

    await core.send('第一次（会抛出）')

    // 应有 error notice
    expect(core.state.transcript.some(i => i.kind === 'notice' && (i as any).level === 'error')).toBe(true)
    // 不应有任何 done=false 的 assistant/reasoning 块
    expect(core.state.transcript.some(i => (i.kind === 'assistant' || i.kind === 'reasoning') && !(i as any).done)).toBe(false)

    // 记录当前 assistant 块数量
    const assistantCountBefore = core.state.transcript.filter(i => i.kind === 'assistant').length

    // 第二次：正常场景
    script.push({
      deltas: ['新的回复'],
      result: { content: '新的回复', toolCalls: [], usage, finishReason: 'stop' },
    })
    await core.send('第二次（正常）')

    // 新的 assistant 块数量应增加（独立的新块，不是追加到旧块）
    const assistantCountAfter = core.state.transcript.filter(i => i.kind === 'assistant').length
    expect(assistantCountAfter).toBeGreaterThan(assistantCountBefore)

    // 第二次回复的内容不应混入第一次的内容
    const lastAssistant = core.state.transcript.filter(i => i.kind === 'assistant').at(-1) as any
    expect(displayTextOf(lastAssistant)).toBe('新的回复')
  })
})

describe('createChatCore /export 默认文件名', () => {
  it('/export 无参 → 写 deepcode-export-<sessionId>.md（默认名复用 sessionIdFromFile）', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'deepcode-export-'))
    const core = createChatCore({ client: {} as any, yolo: true, cwd, sessionDir, onState: () => {} })
    await core.send('/export')
    // 会话落盘文件名去 .jsonl 即默认导出名的 sessionId 段
    const sessionFile = readdirSync(sessionDir).find(f => f.endsWith('.jsonl'))!
    const base = sessionFile.replace(/\.jsonl$/, '')
    const files = readdirSync(cwd)
    expect(files).toContain(`deepcode-export-${base}.md`)
    // base 非空 → 用带 sessionId 的名字，而非兜底名
    expect(files).not.toContain('deepcode-export.md')
    const md = readFileSync(path.join(cwd, `deepcode-export-${base}.md`), 'utf8')
    expect(md).toContain('# deepcode 对话导出')
  })
})
