// test/headless.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// throw：模拟一次上下文超窗错误（供超长重试路径的回归用例复用，写法同 test/headless.overflow.test.ts）。
const script: Array<{ deltas?: any[]; result?: any; throw?: Error }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      if (scene.throw) throw scene.throw
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

const hookCalls: Array<{ event: string; payload: any }> = []
vi.mock('../src/hooks.js', async (orig) => {
  const actual = await orig<typeof import('../src/hooks.js')>()
  return {
    ...actual,
    runHooks: vi.fn(async (event: any, payload: any) => {
      hookCalls.push({ event, payload })
      return { block: false, preventContinuation: false, stop: false, results: [] }
    }),
  }
})

const mockSettings = {
  permissions: { allow: [] },
  compactTokens: 200_000,
  costWarnCNY: 15,
  hooks: {
    SessionStart: [{ matcher: '*', hooks: [] }],
    InstructionsLoaded: [{ matcher: '*', hooks: [] }],
    UserPromptSubmit: [{ matcher: '*', hooks: [] }],
  },
}

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>()
  return {
    ...actual,
    loadSettings: vi.fn(() => mockSettings),
  }
})

vi.mock('../src/settingsLayers.js', async (orig) => {
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

import { runHeadless, WRAP_UP_PROMPT } from '../src/headless.js'
import { chatStream } from '../src/api.js'
import { runHooks } from '../src/hooks.js'
import { loadLayeredSettings } from '../src/settingsLayers.js'
import { traceEnabled, disableTrace } from '../src/requestTrace.js'
import { VERIFICATION_CONTRACT } from '../src/prompt.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 10 }
beforeEach(() => { script.length = 0; hookCalls.length = 0; vi.mocked(chatStream).mockClear() })
afterEach(() => disableTrace())

describe('runHeadless', () => {
  it('跑完单 prompt 返回最终文本与累计 usage/cost/轮数', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'h1', name: 'Glob', args: '{"pattern":"*.md"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '找到 1 个 md 文件', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '有几个 md？', yolo: true })
    expect(r.text).toContain('1 个')
    expect(r.usage.prompt_tokens).toBe(100) // 两轮累计
    expect(r.usage.completion_tokens).toBe(40)
    expect(r.costCNY).toBeGreaterThan(0)
    expect(r.turns).toBe(2)
    expect(r.status).toBe('done')
  })

  it('给了 traceDir 时接线到请求侧轨迹（覆盖 argv → runHeadless → enableTrace 这段接缝，C1 的 bug 长在这里）', async () => {
    script.push({ result: { content: '好', toolCalls: [], usage, finishReason: 'stop' } })
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-headless-'))
    expect(traceEnabled()).toBe(false)
    await runHeadless({ client: {} as any, prompt: '随便问问', yolo: true, traceDir: d })
    expect(traceEnabled()).toBe(true)
  })

  it('非 yolo 时权限询问自动拒绝（headless 无人值守）', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'h2', name: 'Bash', args: '{"command":"touch /tmp/x"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '被拒了', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '建个文件', yolo: false })
    expect(r.status).toBe('done') // 不挂起、不抛错，拒绝理由按正常机制喂回模型
  })

  it('yolo + 无人值守：命中危险命令正则的命令直接放行执行，不因确认门退化成硬拒', async () => {
    // echo --force 的字面串命中 DANGEROUS_PATTERNS（--force），但真实执行毫无副作用——
    // 用它做端到端断言：既验证命令真的跑了（stdout 含 --force），又不碰真实文件系统。
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'h9', name: 'Bash', args: '{"command":"echo --force"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '跑一下', yolo: true })
    expect(r.status).toBe('done')
    const allCalls = vi.mocked(chatStream).mock.calls
    const allMessages: any[] = allCalls.flatMap(([_client, opts]) => opts.messages ?? [])
    const toolMsg = allMessages.find(m => m.role === 'tool' && m.tool_call_id === 'h9')
    expect(toolMsg?.content).toContain('--force') // 命令真的被执行了，不是被拦下的拒绝文案
    expect(toolMsg?.content).not.toContain('yolo 危险命令')
  })

  it('todo 过期时在工具消息中注入 system-reminder', async () => {
    // Turn 1: TaskCreate 建任务（pending 条目），lastUpdateTurn=0，tick→currentTurn=1，delta=1
    // Turn 2: Glob，tick→currentTurn=2，delta=2，无提醒
    // Turn 3: Glob，tick→currentTurn=3，delta=3，提醒触发
    // Turn 4: Glob，tick→currentTurn=4，delta=4（4%3≠0），无提醒
    // Turn 5: stop
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 'tc1', name: 'TaskCreate', args: JSON.stringify({ subject: '修 bug', description: '修复登录问题' }) }],
          usage, finishReason: 'tool_calls',
        },
      },
      {
        result: {
          content: '',
          toolCalls: [{ id: 'g1', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      {
        result: {
          content: '',
          toolCalls: [{ id: 'g2', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      {
        result: {
          content: '',
          toolCalls: [{ id: 'g3', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } },
    )
    await runHeadless({ client: {} as any, prompt: '做任务', yolo: true })
    // 找到最终一次 chatStream 调用，检查其 messages 参数中是否有包含 <system-reminder> + '修 bug' 的 tool 消息
    const allCalls = vi.mocked(chatStream).mock.calls
    const allMessages: any[] = allCalls.flatMap(([_client, opts]) => opts.messages ?? [])
    const reminderMsg = allMessages.find(
      m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('<system-reminder>') && m.content.includes('修 bug'),
    )
    expect(reminderMsg).toBeDefined()
  })

  it('headless 工具表不注册 AskUserQuestion（无人可答）', () => {
    const src = readFileSync(new URL('../src/headless.ts', import.meta.url), 'utf8')
    expect(src.includes('makeAskUserQuestionTool')).toBe(false)
  })

  it('UserPromptSubmit block 时拦截文本同时带上 blockReason 与 additionalContext', async () => {
    vi.mocked(runHooks).mockImplementation(async (event: any, payload: any) => {
      hookCalls.push({ event, payload })
      // 仅 UserPromptSubmit 返回 block + additionalContext，其余事件走默认放行
      if (event === 'UserPromptSubmit') {
        return { block: true, preventContinuation: false, stop: false, blockReason: '拒', additionalContext: '附加上下文', results: [] } as any
      }
      return { block: false, preventContinuation: false, stop: false, results: [] } as any
    })
    try {
      const r = await runHeadless({ client: {} as any, prompt: '坏输入', yolo: true })
      expect(r.status).toBe('aborted')
      expect(r.text).toContain('拒')
      expect(r.text).toContain('附加上下文')
    } finally {
      // mockImplementation 持久，恢复默认放行实现避免污染后续用例
      vi.mocked(runHooks).mockImplementation(async (event: any, payload: any) => {
        hookCalls.push({ event, payload })
        return { block: false, preventContinuation: false, stop: false, results: [] } as any
      })
    }
  })

  it('启动派发 SessionStart(startup) 与 InstructionsLoaded', async () => {
    hookCalls.length = 0
    const memPath = path.join(process.cwd(), 'DEEPCODE.md')
    const createdMem = !existsSync(memPath)
    if (createdMem) writeFileSync(memPath, '# headless 测试记忆')
    try {
      script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
      await runHeadless({ client: {} as any, prompt: '你好', yolo: true })
      const ss = hookCalls.find(c => c.event === 'SessionStart')
      expect(ss?.payload.source).toBe('startup')
      expect(ss?.payload.session_id).toMatch(/^headless-/)
      const il = hookCalls.find(c => c.event === 'InstructionsLoaded' && c.payload.load_reason === 'startup')
      expect(il).toBeTruthy()
      expect(il!.payload.file_path).toContain('DEEPCODE.md')
    } finally {
      if (createdMem) rmSync(memPath, { force: true })
    }
  })
})

describe('headless ask 桶·路径维度接线（不变量：绝不静默失效）', () => {
  afterEach(() => { delete (mockSettings.permissions as any).ask })
  it('permissions.ask 命中路径在 headless（含 yolo）下仍被拦截，不被只读短路静默放行', async () => {
    ;(mockSettings.permissions as any).ask = ['**/.env']
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'ra1', name: 'Read', args: JSON.stringify({ file_path: '.env' }) }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '读一下 .env', yolo: true })
    expect(r.status).toBe('done')
    const allCalls = vi.mocked(chatStream).mock.calls
    const allMessages: any[] = allCalls.flatMap(([_client, opts]) => opts.messages ?? [])
    const toolMsg = allMessages.find(m => m.role === 'tool' && m.tool_call_id === 'ra1')
    expect(toolMsg?.content).toContain('ask 规则')
  })
})

describe('headless availableModels 白名单回落文案', () => {
  afterEach(() => { delete (mockSettings as any).model; delete (mockSettings as any).availableModels })
  it('白名单钳制回落时的提示与共享判定函数 modelFallbackReason 的产出逐字一致（耦合测试：判定条件只许有一份）', async () => {
    // deepseek-v4-flash 明明属于 deepseek（当前 provider），只是没进白名单——若沿用旧文案会撒谎；
    // 期望值写死（不经运行时调用 modelFallbackReason 计算），这样若共享函数内部判定被删/改也能被本用例捕捉
    // （与 test/providers.availableModels.test.ts 里 modelFallbackReason 的同款单测断言保持逐字同步）
    ;(mockSettings as any).model = 'deepseek-v4-flash'
    ;(mockSettings as any).availableModels = ['deepseek-v4-pro']
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
      await runHeadless({ client: {} as any, prompt: '随便问问', yolo: true })
      const msgs = errSpy.mock.calls.map(c => c.join(' '))
      expect(msgs).toContain('[deepcode] settings.model=deepseek-v4-flash 不在 availableModels 白名单内，已回落到 deepseek-v4-pro')
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('headless 剥离的 allow 规则告知', () => {
  it('strippedDangerousRules 非空时经 console.error 播报（绝不只在 /config 里才看得见）', async () => {
    vi.mocked(loadLayeredSettings).mockReturnValueOnce({
      settings: mockSettings, provenance: {}, permissionSources: { allow: {}, deny: {} },
      scopes: [], strippedDangerousRules: ['Bash(npm run:*)', 'Bash(rm -rf dist)'],
    } as any)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
      await runHeadless({ client: {} as any, prompt: '随便问问', yolo: true })
      const msgs = errSpy.mock.calls.map(c => c.join(' '))
      expect(msgs.some(m => m.includes('Bash(npm run:*)') && m.includes('不会生效'))).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })
})

import { checkPermission } from '../src/permissions.js'
import { buildDenySourceMap, resolveDenyList } from '../src/deny.js'

describe('headless thinking / headlessMaxTurns 开关真的接线（不只测 settings 解析，断言 runLoop 实际收到的值）', () => {
  afterEach(() => {
    delete (mockSettings as any).headlessThinking
    delete (mockSettings as any).headlessMaxTurns
    // 用例中途失败时用例自己末尾的 delete 不会执行，这里兜底防止泄漏到同文件其它用例。
    delete process.env.DEEPCODE_FLAGS
  })

  it('headlessThinking:true → chatStream 收到的 opts.thinking === true', async () => {
    ;(mockSettings as any).headlessThinking = true
    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    await runHeadless({ client: {} as any, prompt: '随便问问', yolo: true })
    const [[, callOpts]] = vi.mocked(chatStream).mock.calls
    expect(callOpts.thinking).toBe(true)
  })

  it('headlessMaxTurns:2 → 撞上限后 status 为 max_turns 且恰好只跑了 2 轮（证明真的传进了 runLoop 的 maxTurns，不是默认 80）', async () => {
    ;(mockSettings as any).headlessMaxTurns = 2
    script.push(
      { result: { content: '', toolCalls: [{ id: 'm1', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: '', toolCalls: [{ id: 'm2', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '一直调用工具', yolo: true })
    expect(r.status).toBe('max_turns')
    expect(vi.mocked(chatStream).mock.calls.length).toBe(2)
  })

  it('--max-turns 覆盖 settings.headlessMaxTurns（flag 优先）', async () => {
    ;(mockSettings as any).headlessMaxTurns = 2
    script.push(
      { result: { content: '', toolCalls: [{ id: 'a', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: '', toolCalls: [{ id: 'b', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: '', toolCalls: [{ id: 'c', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '一直调用工具', yolo: true, maxTurns: 3 })
    expect(r.status).toBe('max_turns')
    expect(vi.mocked(chatStream).mock.calls.length).toBe(3) // 收尾轮默认关，故无第 4 次
  })

  it('wrapUpOnMaxTurns 默认关：撞上限后不补收尾轮', async () => {
    delete process.env.DEEPCODE_FLAGS
    ;(mockSettings as any).headlessMaxTurns = 1
    script.push({ result: { content: '', toolCalls: [{ id: 'x', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } })
    const r = await runHeadless({ client: {} as any, prompt: '一直调用工具', yolo: true })
    expect(r.status).toBe('max_turns')
    expect(vi.mocked(chatStream).mock.calls.length).toBe(1)
  })

  it('wrapUpOnMaxTurns 开启：撞上限后补恰好一轮，注入 WRAP_UP_PROMPT', async () => {
    process.env.DEEPCODE_FLAGS = '{"wrapUpOnMaxTurns":true}'
    ;(mockSettings as any).headlessMaxTurns = 1
    script.push(
      { result: { content: '', toolCalls: [{ id: 'x', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: '已落地', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '一直调用工具', yolo: true })
    expect(r.status).toBe('max_turns') // 确实撞了上限，退出码口径不因补一轮而变
    expect(vi.mocked(chatStream).mock.calls.length).toBe(2)
    const [, second] = vi.mocked(chatStream).mock.calls
    const msgs = (second[1] as any).messages as { role: string; content: unknown }[]
    expect(String(msgs.filter(m => m.role === 'user').pop()?.content)).toBe(WRAP_UP_PROMPT)
    delete process.env.DEEPCODE_FLAGS
  })

  it('wrapUpOnMaxTurns 开启时收尾轮也只补一次：它自己再撞上限不会二次触发', async () => {
    process.env.DEEPCODE_FLAGS = '{"wrapUpOnMaxTurns":true}'
    ;(mockSettings as any).headlessMaxTurns = 1
    script.push(
      { result: { content: '', toolCalls: [{ id: 'x', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: '', toolCalls: [{ id: 'y', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '一直调用工具', yolo: true })
    expect(r.status).toBe('max_turns')
    expect(vi.mocked(chatStream).mock.calls.length).toBe(2)
    delete process.env.DEEPCODE_FLAGS
  })

  it('未撞上限（自然收敛）时不触发收尾轮，即便 flag 开着', async () => {
    process.env.DEEPCODE_FLAGS = '{"wrapUpOnMaxTurns":true}'
    ;(mockSettings as any).headlessMaxTurns = 5
    script.push({ result: { content: '做完了', toolCalls: [], usage, finishReason: 'stop' } })
    const r = await runHeadless({ client: {} as any, prompt: '一句话任务', yolo: true })
    expect(r.status).toBe('done')
    expect(vi.mocked(chatStream).mock.calls.length).toBe(1)
    delete process.env.DEEPCODE_FLAGS
  })

  // 回归（复审变异测试实证）：超长重试路径重算剩余预算时必须用 opts.maxTurns（--max-turns）覆盖值，
  // 不能悄悄退回 settings.headlessMaxTurns——否则 --max-turns 在这条路径上静默失效。
  // 用真实大文件垫出 microcompact 能甩的旧 tool 消息（同 test/headless.overflow.test.ts 的 bulkReadTurns 手法），
  // 触发一次真实超窗重试，再用「重试后还能跑几轮」把 remaining 的实际取值暴露出来：
  // 正确取 opts.maxTurns=20 时 remaining=max(1,20-6)=14，足够跑完重试脚本里的 3 轮到 done；
  // 若误取 settings.headlessMaxTurns=7 时 remaining=max(1,7-6)=1，drive(1) 只跑 1 轮就提前撞 max_turns。
  it('超长重试的剩余预算用 opts.maxTurns（--max-turns override）而非 settings.headlessMaxTurns', async () => {
    ;(mockSettings as any).headlessMaxTurns = 7 // 故意设小且不等于 1，与 opts.maxTurns=20 拉开区分度
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-mt-fixture-'))
    const file = path.join(dir, 'big.txt')
    writeFileSync(file, Array.from({ length: 300 }, () => 'x'.repeat(700)).join('\n'))
    for (let i = 0; i < 6; i++) {
      script.push({ result: { content: '', toolCalls: [{ id: `r${i}`, name: 'Read', args: JSON.stringify({ file_path: file }) }], usage, finishReason: 'tool_calls' } })
    }
    script.push({ throw: new Error('This model maximum context length is 128000 tokens') })
    script.push(
      { result: { content: '', toolCalls: [{ id: 'p1', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: '', toolCalls: [{ id: 'p2', name: 'Glob', args: '{"pattern":"*"}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: '重试后完成', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, maxTurns: 20 })
    expect(r.status).toBe('done')
    expect(r.text).toBe('重试后完成')
    expect(vi.mocked(chatStream).mock.calls.length).toBe(10) // 6 铺垫 + 1 抛超窗 + 3 重试后跑完
  })
})

describe('headless deny 文本含来源', () => {
  it('内置私钥路径硬拒绝文本带 来自 内置规则', async () => {
    const tool: any = { name: 'Read', isReadOnly: false, needsPermission: () => 'x', deniablePaths: () => ['/h/.ssh/id_rsa'] }
    const r = await checkPermission(tool, {}, {
      mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no',
      deny: resolveDenyList(), denySources: buildDenySourceMap(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('来自 内置规则')
  })
})

describe('headless 验证合同真的接线（断言 chatStream 实际收到的 system 消息）', () => {
  afterEach(() => { delete process.env.DEEPCODE_FLAGS })

  const firstSystem = () => {
    const [[, callOpts]] = vi.mocked(chatStream).mock.calls
    return String((callOpts as any).messages[0].content)
  }

  it('默认关：system 消息里没有合同', async () => {
    delete process.env.DEEPCODE_FLAGS
    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    await runHeadless({ client: {} as any, prompt: '随便问问', yolo: true })
    expect(firstSystem()).not.toContain(VERIFICATION_CONTRACT)
  })

  it('flag 开：system 消息末尾带上合同正文', async () => {
    process.env.DEEPCODE_FLAGS = '{"verificationAgent":true}'
    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    await runHeadless({ client: {} as any, prompt: '随便问问', yolo: true })
    expect(firstSystem()).toContain(VERIFICATION_CONTRACT)
  })

  it('字符串 "true" 不算开——flags 只认真布尔', async () => {
    process.env.DEEPCODE_FLAGS = '{"verificationAgent":"true"}'
    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    await runHeadless({ client: {} as any, prompt: '随便问问', yolo: true })
    expect(firstSystem()).not.toContain(VERIFICATION_CONTRACT)
  })

  it('非法 JSON 不抛出，退回默认关', async () => {
    process.env.DEEPCODE_FLAGS = '{坏的'
    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    await expect(runHeadless({ client: {} as any, prompt: '随便问问', yolo: true })).resolves.toBeDefined()
    expect(firstSystem()).not.toContain(VERIFICATION_CONTRACT)
  })
})
