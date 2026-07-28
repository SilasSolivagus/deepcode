import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
// capturedMessages[i] = 第 i 次 chatStream 调用时喂进去的 messages（含前一轮 tool 结果），
// 用来在不侵入内部实现的前提下，实读"敏感内容有没有真的被喂回模型"这一真实副作用。
let capturedMessages: any[][] = []
vi.mock('../src/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/api.js')>()
  return { ...actual, chatStream: vi.fn((_client: any, o: any) => (async function* () {
    capturedMessages.push(o.messages)
    const scene = script.shift(); if (!scene) throw new Error('script exhausted')
    for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
    return scene.result
  })()) }
})

import { makeHookRuntime } from '../src/hookRuntime.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../src/tools/structuredOutput.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }

beforeEach(() => { capturedMessages = [] })

describe('makeHookRuntime.llm', () => {
  it('单轮：把 prompt 作 user 消息发 chatStream，返回 content', async () => {
    script.length = 0
    script.push({ result: { content: '{"ok":true}', toolCalls: [], usage, finishReason: 'stop' } })
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.llm!('评估这个', undefined, new AbortController().signal)
    expect(text).toBe('{"ok":true}')
  })
})

describe('makeHookRuntime.runAgent 结构化输出 (L-044)', () => {
  it('hook 子代理调 StructuredOutput({ok:false,reason}) → runAgent 返回该 JSON 串', async () => {
    script.length = 0
    script.push(
      { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ ok: false, reason: '不达标' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.runAgent!('核查', undefined, new AbortController().signal)
    expect(JSON.parse(text)).toEqual({ ok: false, reason: '不达标' })
  })

  it('hook 子代理始终不调 → 重试耗尽兜底返回末条文本（parseHookEvalResult 端 fail-safe）', async () => {
    script.length = 0
    for (let i = 0; i < 8; i++) script.push({ result: { content: '自由文本结论', toolCalls: [], usage, finishReason: 'stop' } })
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.runAgent!('核查', undefined, new AbortController().signal)
    expect(text).toBe('自由文本结论')
  })
})

describe('hookRuntime.runAgent 子回路继承父级安全约束（deny/denyPatterns）', () => {
  it('Read 命中 deny → 拒绝，敏感内容不会被喂回模型（真实 readTool + 真实 checkPermission）', async () => {
    script.length = 0
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookfence-read-'))
    try {
      const secretPath = path.join(dir, 'id_rsa')
      fs.writeFileSync(secretPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nLEAKED_SECRET_CONTENT\n-----END-----')
      script.push(
        { result: { content: '', toolCalls: [{ id: 'r1', name: 'Read', args: JSON.stringify({ file_path: secretPath }) }], usage, finishReason: 'tool_calls' } },
        { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ ok: true }) }], usage, finishReason: 'tool_calls' } },
        { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
      )
      const rt = makeHookRuntime({
        client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => dir,
        parentPermission: () => ({ mode: 'default', rules: [], deny: [secretPath] }),
      })
      await rt.runAgent!('读一下', undefined, new AbortController().signal)
      // 第二次 chatStream 调用喂进去的 messages 里含 Read 的 tool 结果——断言真实私钥内容没有出现在其中。
      const secondCallMessages = capturedMessages[1] ?? []
      const serialized = JSON.stringify(secondCallMessages)
      expect(serialized).not.toContain('LEAKED_SECRET_CONTENT')
      expect(serialized).toMatch(/deny|拒绝/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Grep 命中 denyPatterns → 过滤，敏感行不会被喂回模型（真实 grepTool）', async () => {
    script.length = 0
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookfence-grep-'))
    try {
      fs.writeFileSync(path.join(dir, 'secret.key'), 'TOPSECRET-KEYMATERIAL\n')
      script.push(
        { result: { content: '', toolCalls: [{ id: 'g1', name: 'Grep', args: JSON.stringify({ pattern: 'TOPSECRET' }) }], usage, finishReason: 'tool_calls' } },
        { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ ok: true }) }], usage, finishReason: 'tool_calls' } },
        { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
      )
      const rt = makeHookRuntime({
        client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => dir,
        parentPermission: () => ({ mode: 'default', rules: [] }),
        denyPatterns: () => ['**/secret.key'],
      })
      await rt.runAgent!('搜一下', undefined, new AbortController().signal)
      const secondCallMessages = capturedMessages[1] ?? []
      const serialized = JSON.stringify(secondCallMessages)
      expect(serialized).not.toContain('TOPSECRET-KEYMATERIAL')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('拿不到父快照（未接线）→ fail-safe 回落到无 deny（不比接线前更松，也不抛错）', async () => {
    script.length = 0
    script.push(
      { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ ok: true }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.runAgent!('核查', undefined, new AbortController().signal)
    expect(JSON.parse(text)).toEqual({ ok: true })
  })
})

describe('makeHookRuntime registerAsync', () => {
  it('返回的 deps 含 registerAsync', () => {
    const deps = makeHookRuntime({ client: {} as any, getModel: () => 'm', cwd: () => '/tmp' })
    expect(typeof deps.registerAsync).toBe('function')
  })
})
