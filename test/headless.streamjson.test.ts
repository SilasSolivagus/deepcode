// test/headless.streamjson.test.ts
import { describe, it, expect, vi } from 'vitest'

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
    runHooks: vi.fn(async () => ({ block: false, preventContinuation: false, stop: false, results: [] })),
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

describe('runHeadless stream-json', () => {
  it('输出 init → tool_start → tool_result → result 的 JSONL，stderr 无 ⏺', async () => {
    const { runHeadless } = await import('../src/headless.js')
    script.length = 0
    script.push({ result: { toolCalls: [{ id: 'c1', name: 'Bash', args: JSON.stringify({ command: 'echo hi' }) }], usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 } } })
    script.push({ deltas: ['ok'], result: { toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 } } })

    const lines: string[] = []
    const errs: string[] = []
    const espy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { errs.push(String(s)); return true }) as any)
    const r = await runHeadless({
      client: {} as any, prompt: '跑命令', yolo: true,
      outputFormat: 'stream-json',
      write: s => lines.push(s),
      home: '/tmp/dc-sj-' + Math.random().toString(36).slice(2),
    })
    espy.mockRestore()

    const events = lines.join('').trim().split('\n').map(l => JSON.parse(l))
    expect(events[0].type).toBe('init')
    expect(events.some(e => e.type === 'tool_start' && e.name === 'Bash' && e.input.command === 'echo hi')).toBe(true)
    expect(events.some(e => e.type === 'tool_result' && e.id === 'c1')).toBe(true)
    expect(events.at(-1).type).toBe('result')
    expect(events.at(-1).text).toBe(r.text)
    // stream-json 下 stderr 不写 ⏺ 摘要
    expect(errs.some(e => e.includes('⏺'))).toBe(false)
  })
})
