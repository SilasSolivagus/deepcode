import { describe, it, expect } from 'vitest'
import { Assembler, chatStream } from '../src/api.js'

describe('Assembler usage 归一', () => {
  it('deepseek dialect 读顶层 prompt_cache_hit_tokens', () => {
    const a = new Assembler('deepseek')
    a.push({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(40)
  })
  it('glm dialect 读嵌套 prompt_tokens_details.cached_tokens 归一', () => {
    const a = new Assembler('glm')
    a.push({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 25 } }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(25)
  })
  it('openai dialect 无缓存字段 → 0', () => {
    const a = new Assembler('openai')
    a.push({ usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(0)
  })
  it('kimi dialect 读顶层 cached_tokens 归一', () => {
    const a = new Assembler('kimi')
    a.push({ usage: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 33 }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(33)
  })
  it('kimi dialect 无缓存字段 → 0（不产生 undefined 污染成本）', () => {
    const a = new Assembler('kimi')
    a.push({ usage: { prompt_tokens: 12, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 19 } }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(0)
  })
  it('缺省构造器 = deepseek', () => {
    const a = new Assembler()
    a.push({ usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 1 }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(1)
  })
})

function fakeClient(captured: any[]) {
  return {
    chat: {
      completions: {
        create: async (payload: any) => {
          captured.push(payload)
          return (async function* () {
            yield {
              choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }
          })()
        },
      },
    },
  } as any
}

describe('chatStream thinking 字段不泄漏', () => {
  const drain = async (gen: AsyncGenerator<any, any>) => {
    let s = await gen.next()
    while (!s.done) s = await gen.next()
    return s.value
  }

  it('supportsThinking=false → payload 不含 thinking/reasoning_effort', async () => {
    const cap: any[] = []
    await drain(
      chatStream(fakeClient(cap), {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        thinking: true,
        signal: new AbortController().signal,
        dialect: 'openai',
        supportsThinking: false,
      }),
    )
    expect(cap[0]).not.toHaveProperty('thinking')
    expect(cap[0]).not.toHaveProperty('reasoning_effort')
  })

  it('supportsThinking=true + thinking → payload 含 thinking enabled + reasoning_effort', async () => {
    const cap: any[] = []
    await drain(
      chatStream(fakeClient(cap), {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        thinking: true,
        effortLevel: 'high',
        signal: new AbortController().signal,
        dialect: 'deepseek',
        supportsThinking: true,
      }),
    )
    expect(cap[0].thinking).toEqual({ type: 'enabled' })
    expect(cap[0].reasoning_effort).toBe('high')
  })
})

describe('buildThinkingParams 三态', () => {
  it('supportsThinking=false → 空对象（不发 thinking/reasoning_effort）', async () => {
    const { buildThinkingParams } = await import('../src/api.js')
    expect(buildThinkingParams(false, true, 'low')).toEqual({})
    expect(buildThinkingParams(false, false, 'low')).toEqual({})
  })
  it('supportsThinking=true + thinking 开 → enabled + reasoning_effort', async () => {
    const { buildThinkingParams } = await import('../src/api.js')
    expect(buildThinkingParams(true, true, 'high')).toEqual({ reasoning_effort: 'high', thinking: { type: 'enabled' } })
  })
  it('supportsThinking=true + thinking 关 → disabled', async () => {
    const { buildThinkingParams } = await import('../src/api.js')
    expect(buildThinkingParams(true, false, undefined)).toEqual({ thinking: { type: 'disabled' } })
  })
  it('thinkingOnly + thinking 关 → 省略 disabled（防端点 400）', async () => {
    const { buildThinkingParams } = await import('../src/api.js')
    expect(buildThinkingParams(true, false, undefined, true)).toEqual({})
  })
  it('thinkingOnly + thinking 开 → 正常 enabled', async () => {
    const { buildThinkingParams } = await import('../src/api.js')
    expect(buildThinkingParams(true, true, 'low', true)).toEqual({ reasoning_effort: 'low', thinking: { type: 'enabled' } })
  })
})

describe('normalizeUsage 各方言缓存字段', () => {
  it('deepseek/glm/kimi/openai 各取正确位置，缺省兜零', async () => {
    const { normalizeUsage } = await import('../src/api.js')
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 }, 'deepseek').prompt_cache_hit_tokens).toBe(4)
    expect(normalizeUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } }, 'glm').prompt_cache_hit_tokens).toBe(5)
    expect(normalizeUsage({ prompt_tokens: 10, cached_tokens: 6 }, 'kimi').prompt_cache_hit_tokens).toBe(6)
    expect(normalizeUsage({ prompt_tokens: 10 }, 'openai').prompt_cache_hit_tokens).toBe(0)
    // 完全空的 usage：三字段全兜零，绝不产 undefined
    expect(normalizeUsage(undefined, 'kimi')).toEqual({ prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 })
  })
})
