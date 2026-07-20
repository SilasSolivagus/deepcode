// test/recap.test.ts
import { describe, it, expect, vi } from 'vitest'

const script: Array<{ result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() => (async function* () {
    const scene = script.shift(); if (!scene) throw new Error('script exhausted')
    return scene.result
  })()),
}))

import { generateRecap, RECAP_PROMPT } from '../src/recap.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

describe('generateRecap', () => {
  it('空会话（无 user/assistant）返回 null，不调模型', async () => {
    const r = await generateRecap({} as any, [{ role: 'system', content: 'x' }], 'deepseek-v4-pro', new AbortController().signal)
    expect(r).toBe(null)
  })
  it('有会话时用给定 model 单发并返回 trim 文本', async () => {
    script.push({ result: { content: '  在做 A，下一步 B。  ', usage, finishReason: 'stop' } })
    const r = await generateRecap({} as any, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], 'deepseek-v4-pro', new AbortController().signal)
    expect(r).toBe('在做 A，下一步 B。')
  })
  it('RECAP_PROMPT 含 40 词与 markdown 约束', () => {
    expect(RECAP_PROMPT).toMatch(/40/); expect(RECAP_PROMPT).toMatch(/markdown/)
  })
})
