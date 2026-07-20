import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 脚本化的 chatStream：每次调用从 script 取下一幕
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

import { runLoop, type LoopDeps } from '../src/loop.js'
import { readTool } from '../src/tools/read.js'
import {
  registerTask,
  enqueueNotification,
  getTask,
  clearAllTasks,
  drainNotifications,
  type BackgroundTask,
} from '../src/tasks.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }

function makeDeps(tools: any[]): LoopDeps {
  return {
    client: {} as any,
    tools,
    model: 'deepseek-v4-flash',
    thinking: false,
    permission: { mode: 'yolo', rules: [], saveRule: () => {}, ask: async () => 'no' },
    ctx: { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() },
  }
}

async function drain(gen: AsyncGenerator<any, any>) {
  const events: any[] = []
  let r
  while (!(r = await gen.next()).done) events.push(r.value)
  return { events, ret: r.value }
}

beforeEach(() => { script.length = 0; clearAllTasks(); drainNotifications() })

describe('malformed-tool-use 自愈重试', () => {
  it('正文泄漏工具调用意图且无 tool_call → 注入重试并续跑一次', async () => {
    script.push({ result: { content: '我来读文件 <invoke name="Read">…', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ result: { content: '已完成', toolCalls: [], usage, finishReason: 'stop' } })
    const messages: any[] = [{ role: 'user', content: 'read a file' }]
    await drain(runLoop(messages, makeDeps([readTool])))
    expect(script.length).toBe(0) // 第二幕被消费 = 续跑了
    expect(messages.some(m => m.role === 'user' && String(m.content).includes('未能产生有效的工具调用'))).toBe(true)
  })

  it('守卫限一次：连续两次泄漏只重试一次，第二次落回自然结束', async () => {
    script.push({ result: { content: '<function_calls>…', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ result: { content: '<function_calls>又泄漏', toolCalls: [], usage, finishReason: 'stop' } })
    const messages: any[] = [{ role: 'user', content: 'go' }]
    await drain(runLoop(messages, makeDeps([readTool])))
    expect(script.length).toBe(0)
    const retries = messages.filter(m => m.role === 'user' && String(m.content).includes('未能产生有效的工具调用'))
    expect(retries.length).toBe(1) // 只注入一次
  })

  it('length 截断 + 含泄漏串 → 走 length 续写不走 malformed', async () => {
    script.push({ result: { content: '一段被截断的 <invoke', toolCalls: [], usage, finishReason: 'length' } })
    script.push({ result: { content: '续完', toolCalls: [], usage, finishReason: 'stop' } })
    const messages: any[] = [{ role: 'user', content: 'go' }]
    await drain(runLoop(messages, makeDeps([readTool])))
    expect(messages.some(m => m.role === 'user' && String(m.content).includes('因长度上限被截断'))).toBe(true)
    expect(messages.some(m => m.role === 'user' && String(m.content).includes('未能产生有效的工具调用'))).toBe(false)
  })

  it('正常无泄漏正文 → 不重试', async () => {
    script.push({ result: { content: '普通回答，没有工具标记', toolCalls: [], usage, finishReason: 'stop' } })
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, makeDeps([readTool])))
    expect(messages.some(m => m.role === 'user' && String(m.content).includes('未能产生有效的工具调用'))).toBe(false)
  })
})
