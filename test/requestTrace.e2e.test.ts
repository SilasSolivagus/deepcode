// 端到端：开启轨迹后真的走 chatStream 一遭，断言落盘内容就是发出去的东西。
// mock 掉 OpenAI 客户端而非 chatStream 本身——本任务要验的正是 chatStream 内部的接入。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chatStream } from '../src/api.js'
import { enableTrace, disableTrace, resolveTraceDir } from '../src/requestTrace.js'

afterEach(() => disableTrace())

/** 最小假客户端：产出一个空流即可，本测试只关心「发出去了什么」。 */
const fakeClient = {
  chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() { /* 空流 */ } }) } },
} as any

async function drain(gen: AsyncGenerator<any, any>): Promise<void> {
  while (!(await gen.next()).done) { /* 排空 */ }
}

describe('chatStream 接入请求侧轨迹', () => {
  it('未开启时不产生任何文件', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-e2e-'))
    await drain(chatStream(fakeClient, {
      model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], tools: [],
      thinking: false, signal: new AbortController().signal,
    }))
    expect(readdirSync(d)).toHaveLength(0)
  })

  it('开启后落盘一条，内容含真正发出去的 messages 与 label', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-e2e-'))
    enableTrace(d)
    await drain(chatStream(fakeClient, {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '把这句录下来' }],
      tools: [{ type: 'function', function: { name: 'Read' } }],
      thinking: false,
      signal: new AbortController().signal,
      traceLabel: 'turn',
    }))
    const files = readdirSync(d).filter(n => n.startsWith('req-'))
    expect(files).toEqual(['req-00001.json'])
    const rec = JSON.parse(readFileSync(path.join(d, files[0]), 'utf8'))
    expect(rec.label).toBe('turn')
    expect(rec.model).toBe('deepseek-v4-pro')
    expect(rec.messages).toEqual([{ role: 'user', content: '把这句录下来' }])
    expect(rec.tools).toHaveLength(1)
    // params 照实落盘，不做键的挑选
    expect(rec.params.stream).toBe(true)
    expect(rec.params.stream_options).toEqual({ include_usage: true })
  })

  it('未传 traceLabel 时记为 unknown', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-e2e-'))
    enableTrace(d)
    await drain(chatStream(fakeClient, {
      model: 'deepseek-v4-pro', messages: [], tools: [],
      thinking: false, signal: new AbortController().signal,
    }))
    const f = readdirSync(d).filter(n => n.startsWith('req-'))[0]
    expect(JSON.parse(readFileSync(path.join(d, f), 'utf8')).label).toBe('unknown')
  })
})

describe('headless 开关接线', () => {
  it('--trace 优先于 DEEPCODE_TRACE_DIR', () => {
    expect(resolveTraceDir(['-p', 'x', '--trace', '/tmp/a'], { DEEPCODE_TRACE_DIR: '/tmp/b' } as any)).toBe('/tmp/a')
  })
  it('只设环境变量也生效', () => {
    expect(resolveTraceDir(['-p', 'x'], { DEEPCODE_TRACE_DIR: '/tmp/b' } as any)).toBe('/tmp/b')
  })
})
