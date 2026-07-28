// Critical 1 回归：子代理 Bash cd 到围栏外后，传相对路径给 Write/Read 能穿透工作目录围栏与 deny 规则。
// 根因：checkPermission 判定用 pc.cwd（=fenceRoot，构造时定死）解析相对路径，
// 而工具执行用 ctx.cwd()（=subCwd，会被子代理内 Bash cd 漂移）解析同一相对路径——
// 两个不同基准，判定"在围栏内"而实际写/读到围栏外。
// 全程走真实 bashTool/writeTool/readTool + 真实 runSubagent + checkPermission，只 mock chatStream 脚本化工具调用序列，
// 断言落在磁盘上的真实副作用（不是文本返回值）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async orig => {
  const actual = await orig<typeof import('../src/api.js')>()
  return {
    ...actual,
    chatStream: vi.fn(() => (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })()),
  }
})

import { runSubagent } from '../src/subagentRunner.js'
import { bashTool } from '../src/tools/bash.js'
import { writeTool } from '../src/tools/write.js'
import { readTool } from '../src/tools/read.js'
import type { PermissionSnapshot } from '../src/permissions.js'
import type { Tool, ToolContext } from '../src/tools/types.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }

/** 包一层真实工具，只是把它真实的返回值捕获出来供断言（不改动任何安全逻辑）。 */
function spyOn<T extends Tool<any>>(tool: T, sink: { last?: string }): T {
  return { ...tool, call: async (input: any, ctx: ToolContext) => (sink.last = await tool.call(input, ctx)) } as T
}

describe('Critical 1：子代理 cd 出围栏 + 相对路径穿透', () => {
  let fenceRoot: string
  let outsideDir: string

  beforeEach(() => {
    script.length = 0
    fenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-root-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-outside-'))
  })

  afterEach(() => {
    fs.rmSync(fenceRoot, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  it('Bash cd 到围栏外 + Write 相对路径 → 磁盘上围栏外无文件落地', async () => {
    script.push(
      { result: { content: '', toolCalls: [{ id: 'c1', name: 'Bash', args: JSON.stringify({ command: `cd ${outsideDir}` }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: '', toolCalls: [{ id: 'c2', name: 'Write', args: JSON.stringify({ file_path: 'pwned.txt', content: 'pwned' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const parent: PermissionSnapshot = { mode: 'default', rules: [] }
    const ctx: ToolContext = {
      cwd: () => fenceRoot, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
      parentPermission: () => parent,
    } as any

    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [bashTool, writeTool], model: 'm', ctx, signal: new AbortController().signal,
      agentId: 'a1', agentType: 'general-purpose',
    })

    // 核心断言：围栏外目录里绝不能出现被写入的文件
    expect(fs.existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false)
  })

  it('Bash cd 到围栏外 + Read 相对路径 → 读不到围栏外的敏感文件（deny 不被 cd 绕过）', async () => {
    const secretPath = path.join(outsideDir, 'credentials')
    fs.writeFileSync(secretPath, 'aws_secret_access_key=LEAKED')

    script.push(
      { result: { content: '', toolCalls: [{ id: 'c1', name: 'Bash', args: JSON.stringify({ command: `cd ${outsideDir}` }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: '', toolCalls: [{ id: 'c2', name: 'Read', args: JSON.stringify({ file_path: 'credentials' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    // 精确绝对路径 deny（镜像 BUILTIN_DENY 里 '~/.aws/credentials' 这类非 glob 精确规则），
    // 只命中 outsideDir 下的真实文件，不会误命中 fenceRoot 下同名解析（用来排除"判定侧误报"的假阳性）。
    const parent: PermissionSnapshot = { mode: 'default', rules: [], deny: [secretPath] }
    const ctx: ToolContext = {
      cwd: () => fenceRoot, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
      parentPermission: () => parent,
    } as any

    const sink: { last?: string } = {}
    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [bashTool, spyOn(readTool, sink)], model: 'm', ctx, signal: new AbortController().signal,
      agentId: 'a2', agentType: 'general-purpose',
    })

    // 核心断言：真实 Read 工具调用的返回值里绝不能出现泄露的密钥内容
    expect(sink.last).not.toContain('LEAKED')
    expect(sink.last).toMatch(/错误：文件不存在/)
  })

  it('对照：不 cd、直接绝对路径读同一敏感文件 → 被 deny 规则拒绝（确认这条 deny 规则本身有效）', async () => {
    const secretPath = path.join(outsideDir, 'credentials')
    fs.writeFileSync(secretPath, 'aws_secret_access_key=LEAKED')
    script.push(
      { result: { content: '', toolCalls: [{ id: 'c1', name: 'Read', args: JSON.stringify({ file_path: secretPath }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const parent: PermissionSnapshot = { mode: 'default', rules: [], deny: [secretPath] }
    const ctx: ToolContext = {
      cwd: () => fenceRoot, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
      parentPermission: () => parent,
    } as any
    const sink: { last?: string } = {}
    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [spyOn(readTool, sink)], model: 'm', ctx, signal: new AbortController().signal,
      agentId: 'a3', agentType: 'general-purpose',
    })
    // deny 在 checkPermission 层直接拦截，tool.call 根本不会被真正执行
    expect(sink.last).toBeUndefined()
  })
})
