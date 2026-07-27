import { describe, it, expect } from 'vitest'
import { parseToolInput, streamInit, streamFromLoopEvent, streamResult, parseOutputFormat } from '../src/streamJson.js'
import type { LoopEvent } from '../src/loop.js'

const parse = (line: string | null) => JSON.parse((line ?? '').trim())

describe('parseToolInput', () => {
  it('合法 JSON 转对象', () => {
    expect(parseToolInput('{"command":"ls"}')).toEqual({ command: 'ls' })
  })
  it('非法 JSON 包成 {raw}', () => {
    expect(parseToolInput('{坏')).toEqual({ raw: '{坏' })
  })
})

describe('streamInit', () => {
  it('init 事件字段', () => {
    const o = parse(streamInit({ sessionId: 'headless-ab12', cwd: '/repo', model: 'deepseek-v4-pro', yolo: false }))
    expect(o).toEqual({ type: 'init', session_id: 'headless-ab12', cwd: '/repo', model: 'deepseek-v4-pro', yolo: false })
  })
  it('以换行结尾', () => {
    expect(streamInit({ sessionId: 's', cwd: '/', model: 'm', yolo: true }).endsWith('\n')).toBe(true)
  })
})

describe('streamFromLoopEvent', () => {
  it('text 事件', () => {
    const ev: LoopEvent = { type: 'text', delta: '你好', reasoning: false }
    expect(parse(streamFromLoopEvent(ev))).toEqual({ type: 'text', delta: '你好', reasoning: false })
  })
  it('text 事件 reasoning 缺省为 false', () => {
    const ev: LoopEvent = { type: 'text', delta: 'x' }
    expect(parse(streamFromLoopEvent(ev)).reasoning).toBe(false)
  })
  it('tool_start：input 从 JSON 串转对象', () => {
    const ev: LoopEvent = { type: 'tool_start', id: 'c1', name: 'Bash', desc: '{"command":"echo hi"}' }
    expect(parse(streamFromLoopEvent(ev))).toEqual({ type: 'tool_start', id: 'c1', name: 'Bash', input: { command: 'echo hi' } })
  })
  it('tool_start：坏 JSON → input.raw', () => {
    const ev: LoopEvent = { type: 'tool_start', id: 'c1', name: 'X', desc: '{坏' }
    expect(parse(streamFromLoopEvent(ev)).input).toEqual({ raw: '{坏' })
  })
  it('tool_end → tool_result，带完整 content', () => {
    const ev: LoopEvent = { type: 'tool_end', id: 'c1', ok: true, preview: 'p', previewExtra: 0, ms: 12, content: '完整结果' }
    expect(parse(streamFromLoopEvent(ev))).toEqual({ type: 'tool_result', id: 'c1', ok: true, content: '完整结果', ms: 12 })
  })
  it('turn_end 带 usage', () => {
    const ev: LoopEvent = { type: 'turn_end', usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 0 }, sentLen: 3 }
    expect(parse(streamFromLoopEvent(ev))).toEqual({ type: 'turn_end', usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 0 } })
  })
})

describe('streamResult', () => {
  it('result 事件 = HeadlessResult 字段', () => {
    const o = parse(streamResult({ text: '最终', status: 'done', turns: 2, usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }, costCNY: 0.01 }))
    expect(o).toEqual({ type: 'result', status: 'done', turns: 2, usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }, costCNY: 0.01, text: '最终' })
  })
})

describe('parseOutputFormat', () => {
  it('默认 text', () => {
    expect(parseOutputFormat(['-p', '任务'])).toBe('text')
  })
  it('--json 别名 → json', () => {
    expect(parseOutputFormat(['-p', '任务', '--json'])).toBe('json')
  })
  it('--output-format 三档', () => {
    expect(parseOutputFormat(['--output-format', 'stream-json'])).toBe('stream-json')
    expect(parseOutputFormat(['--output-format', 'json'])).toBe('json')
    expect(parseOutputFormat(['--output-format', 'text'])).toBe('text')
  })
  it('--output-format 优先于 --json', () => {
    expect(parseOutputFormat(['--json', '--output-format', 'stream-json'])).toBe('stream-json')
  })
  it('非法值抛错', () => {
    expect(() => parseOutputFormat(['--output-format', 'yaml'])).toThrow()
  })
})
