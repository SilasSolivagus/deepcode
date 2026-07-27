// test/headless.trace.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

vi.mock('../src/hooks.js', async (orig) => {
  const actual = await orig<typeof import('../src/hooks.js')>()
  return {
    ...actual,
    runHooks: vi.fn(async (event: any, payload: any) => {
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
    })),
  }
})

import { runHeadless } from '../src/headless.js'
import { chatStream } from '../src/api.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 10 }
beforeEach(() => { script.length = 0; vi.mocked(chatStream).mockClear() })

describe('headless stderr 轨迹', () => {
  it('Read 轨迹显示完整长路径，不切在中间', async () => {
    const longPath = '/Users/x/very/long/nested/path/to/some/deeply/buried/module/directory/structure/that/goes/on/for/a/while/name.ts'
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'c1', name: 'Read', args: JSON.stringify({ file_path: longPath }) }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const errs: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { errs.push(String(s)); return true }) as any)
    try {
      await runHeadless({ client: {} as any, prompt: '读文件', yolo: true, home: '/tmp/dc-trace-' + Math.random().toString(36).slice(2) })
    } finally {
      spy.mockRestore()
    }
    const trace = errs.find(e => e.includes('⏺ Read('))
    expect(trace).toBeTruthy()
    expect(trace).toContain(longPath) // 完整路径可见，不被切在中间
  })
})
