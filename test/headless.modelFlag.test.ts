// test/headless.modelFlag.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseModelFlag } from '../src/providers.js'

const script: Array<{ result?: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })(),
  ),
}))

// settings.model 故意设成 deepseek-v4-flash：与 --model 要传的值不同，
// 「flag 生效了」与「碰巧回落到同一个默认值」才分得开。
const mockSettings: any = {
  permissions: { allow: [] },
  compactTokens: 200_000,
  model: 'deepseek-v4-flash',
  hooks: { SessionStart: [{ matcher: '*', hooks: [] }], InstructionsLoaded: [{ matcher: '*', hooks: [] }], UserPromptSubmit: [{ matcher: '*', hooks: [] }] },
}

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>()
  return { ...actual, loadSettings: vi.fn(() => mockSettings) }
})
vi.mock('../src/settingsLayers.js', async (orig) => {
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
import { chatStream } from '../src/api.js'
import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }
const done = { result: { content: '好了', toolCalls: [], usage, finishReason: 'stop' } }

beforeEach(() => {
  script.length = 0
  vi.mocked(chatStream).mockClear()
  mockSettings.model = 'deepseek-v4-flash'
  delete mockSettings.availableModels
})

/** 真正发出去的那个 model —— 断言在这一层，而不是断言某个中间变量。
 *  中间变量对了但没接到 chatStream，正是这个 bug 的形态。 */
const sentModel = () => (vi.mocked(chatStream).mock.calls[0][1] as any).model

describe('parseModelFlag', () => {
  it('未传时返回 undefined（沿用 settings.model）', () => {
    expect(parseModelFlag(['-p', '任务'])).toBeUndefined()
  })
  it('正常取值原样返回', () => {
    expect(parseModelFlag(['--model', 'glm-5.2', '-p', '任务'])).toBe('glm-5.2')
  })
  it('缺少取值时报错', () => {
    expect(() => parseModelFlag(['-p', '任务', '--model'])).toThrow(/--model/)
  })
  it('取值是另一个 flag 时报错，不把它当模型名吞掉', () => {
    // 修复前是裸取 argv[i+1]：`--model -p "任务"` 会把 `-p` 当模型名读走。
    for (const bad of ['-p', '--yolo', '']) {
      expect(() => parseModelFlag(['--model', bad]), `值=${JSON.stringify(bad)}`).toThrow(/--model/)
    }
  })
})

describe('runHeadless 认 --model', () => {
  it('传了 model 就用它，而不是 settings.model（回归：此前静默忽略）', async () => {
    script.push(done)
    await runHeadless({ client: {} as any, prompt: '任务', yolo: true, model: 'deepseek-v4-pro' })
    expect(sentModel()).toBe('deepseek-v4-pro')
  })

  it('没传 model 时仍走 settings.model，行为不变', async () => {
    script.push(done)
    await runHeadless({ client: {} as any, prompt: '任务', yolo: true })
    expect(sentModel()).toBe('deepseek-v4-flash')
  })

  it('--model 仍受 availableModels 白名单钳制，不给 flag 开后门', async () => {
    // ⚠️ 白名单钳制的回落目标是 preset.models.smart，deepseek 的 smart 就是 deepseek-v4-pro。
    // 所以请求值必须挑一个「不等于 smart」的，否则「被钳制」与「没钳制」读数相同、断言零区分度。
    mockSettings.availableModels = ['deepseek-v4-pro']
    script.push(done)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runHeadless({ client: {} as any, prompt: '任务', yolo: true, model: 'deepseek-v4-flash' })
    expect(sentModel()).toBe('deepseek-v4-pro')   // 回落到默认档
    expect(sentModel()).not.toBe('deepseek-v4-flash')
    // 告警必须指明来源是 --model：说成 settings.model 会让用户去翻一个自己没写过的配置项
    const msgs = err.mock.calls.map(c => String(c[0])).join('\n')
    expect(msgs).toContain('--model=')
    expect(msgs).not.toContain('settings.model=')
    err.mockRestore()
  })

  it('被推翻的是 settings.model 时，告警仍说 settings.model', async () => {
    mockSettings.availableModels = ['deepseek-v4-pro']
    mockSettings.model = 'deepseek-v4-flash'
    script.push(done)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runHeadless({ client: {} as any, prompt: '任务', yolo: true })
    const msgs = err.mock.calls.map(c => String(c[0])).join('\n')
    expect(msgs).toContain('settings.model=')
    expect(msgs).not.toContain('--model=')
    err.mockRestore()
  })
})

describe('createChatCore 真的用了传进来的 model', () => {
  // 与 permissionMode 同一课：源码文本断言只验「线接上了」，验不出「接到的东西被用了」。
  const mk = (extra: any) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelflag-'))
    return createChatCore({ client: {} as any, cwd: dir, sessionDir: dir, home: dir, onState: () => {}, yolo: true, ...extra })
  }
  it('传了 model 就用它，而不是 settings.model', () => {
    expect(mk({ model: 'deepseek-v4-pro' }).model()).toBe('deepseek-v4-pro')
  })
  it('没传时仍走 settings.model，行为不变', () => {
    expect(mk({}).model()).toBe('deepseek-v4-flash')
  })
})

describe('双组件对称接线护栏：--model', () => {
  // 同 test/updater.wiring.test.ts 的理由：默认渲染器是 FullscreenApp，只改 App.tsx 会让
  // --model 在默认渲染模式下静默失效，而这一层从渲染侧无法廉价观测。此坑历史上复发过多次。
  it('App 与 FullscreenApp 都声明 model 并把它交给 createChatCore', () => {
    for (const f of ['src/tui/App.tsx', 'src/tui/FullscreenApp.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8')
      expect(src, `${f} 缺 model props 声明`).toMatch(/model\?: string/)
      expect(src, `${f} 没把 model 传给 createChatCore`).toContain('model: props.model')
    }
  })

  it('startTui 把 model 交给渲染的那个组件', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/tui/index.tsx'), 'utf8')
    expect(src).toContain('model={opts.model}')
  })
})
