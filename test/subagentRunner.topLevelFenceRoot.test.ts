// Critical 2 回归：顶层会话 ctx.cwd() 被真实 Bash cd 漂移后，subagentRunner 用
// `ctx.fenceRoot ?? ctx.cwd()` 求 fenceRoot——顶层 ctx 从无 fenceRoot 字段，落到已漂移的
// ctx.cwd()，子代理围栏根被污染成漂移后的位置（本该由 parentPerm.cwd 这个"回合冻结快照"顶替）。
// useChat.ts/headless.ts/backgroundRunner.ts 喂给 checkPermission 的 permission.cwd 是回合开始时
// 的值快照，不随回合内 Bash cd 漂移；父代理在同一回合里写漂移后的目录仍会被问人，
// 它派出的子代理却因为 fenceRoot 跟着漂移而静默放行——这是真越权，不是"与父级一致"。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { z } from 'zod'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tool, ToolContext } from '../src/tools/types.js'
import type { PermissionSnapshot } from '../src/permissions.js'

let chatCalls = 0
let lastToolCallName = ''
vi.mock('../src/api.js', () => ({
  async *chatStream() {
    chatCalls++
    if (chatCalls === 1) {
      return {
        content: '', finishReason: 'tool_calls',
        usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
        toolCalls: [{ id: 'c1', name: lastToolCallName, args: '{}' }],
      }
    }
    yield { type: 'text', delta: 'done' }
    return {
      content: 'done', finishReason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
      toolCalls: [],
    }
  },
}))

import { runSubagent } from '../src/subagentRunner.js'
import { bashTool } from '../src/tools/bash.js'
import { exitWorktreeTool } from '../src/tools/exitWorktree.js'

afterEach(() => { chatCalls = 0; lastToolCallName = '' })

const mkWriteStub = (target: string, seen: { called: boolean }): Tool => ({
  name: 'Write',
  description: 'write',
  inputSchema: z.object({}),
  isReadOnly: false,
  needsPermission: () => `write ${target}`,
  deniablePaths: () => [target],
  workspacePaths: () => [target],
  call: async () => { seen.called = true; return 'ok' },
})

describe('Critical 2：顶层会话 cwd 漂移不得污染子代理围栏根', () => {
  it('顶层 ctx 经真实 bashTool.call 的 cd 漂移后派子代理 → 围栏外写入被拒（用回合冻结的 parentPerm.cwd，不用已漂移的 ctx.cwd()）', async () => {
    const fenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toplevel-fence-'))
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toplevel-outside-'))
    try {
      let liveCwd = fenceRoot
      // 模拟 useChat.ts/headless.ts/backgroundRunner.ts 的顶层 ctx：
      // cwd() 是活的（会被 Bash cd 漂移），parentPermission().cwd 是本回合开始时冻结的快照。
      const roundCwdSnapshot = fenceRoot
      const parentSnap: PermissionSnapshot = { mode: 'default', rules: [], cwd: roundCwdSnapshot }
      const topCtx: ToolContext = {
        cwd: () => liveCwd,
        setCwd: (d: string) => { liveCwd = d },
        get signal() { return new AbortController().signal },
        fileState: new Map(),
        parentPermission: () => parentSnap,
        // 顶层会话没有 fenceRoot 字段（与生产代码一致，见 tools/types.ts 注释）
      } as any

      // 真实 Bash cd：模拟本回合内主会话已经 cd 到围栏外（漂移 ctx.cwd()，但不影响 parentPerm.cwd 快照）
      await bashTool.call({ command: `cd ${outsideDir}` }, topCtx)
      expect(topCtx.cwd()).toBe(outsideDir) // 确认漂移真的发生了

      const seen = { called: false }
      lastToolCallName = 'Write'
      await runSubagent({
        client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
        tools: [mkWriteStub(path.join(outsideDir, 'evil.txt'), seen)], model: 'm',
        ctx: topCtx, signal: new AbortController().signal,
        agentId: 'child', agentType: 'general-purpose',
      })
      // 若 fenceRoot 落到了漂移后的 outsideDir，工作目录围栏对 outsideDir 内路径恒判"在围栏内"，
      // 子代理无审批 UI 会静默放行、call 会执行；围栏根若正确取 parentPerm.cwd，则判"围栏外"→ 子代理侧拒。
      expect(seen.called).toBe(false)
    } finally {
      fs.rmSync(fenceRoot, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('ExitWorktree 方向（worktree → 主仓库，cwd 变宽）→ 子代理围栏根仍锁定回合冻结值，写主仓库路径被拒', async () => {
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toplevel-wt-'))
    const mainRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toplevel-mainrepo-'))
    try {
      let liveCwd = worktreeDir
      // 回合开始时会话正处于 worktree 内——parentPerm.cwd 快照即 worktreePath。
      const parentSnap: PermissionSnapshot = { mode: 'default', rules: [], cwd: worktreeDir }
      let wsState: any = {
        originalCwd: mainRepoDir, worktreePath: worktreeDir,
        worktreeBranch: '', headCommit: '', gitRoot: '', hookBased: true,
      }
      const topCtx: ToolContext = {
        cwd: () => liveCwd,
        setCwd: (d: string) => { liveCwd = d },
        get signal() { return new AbortController().signal },
        fileState: new Map(),
        parentPermission: () => parentSnap,
        worktreeSession: { get: () => wsState, set: (s: any) => { wsState = s } },
      } as any

      // 真实 ExitWorktree：本回合内从 worktree 退回主仓库（cwd 变宽，hookBased 路径跳过 git 检测）
      await exitWorktreeTool.call({ action: 'keep' }, topCtx)
      expect(topCtx.cwd()).toBe(mainRepoDir) // 确认已经"变宽"到主仓库

      const seen = { called: false }
      lastToolCallName = 'Write'
      await runSubagent({
        client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
        tools: [mkWriteStub(path.join(mainRepoDir, 'evil.txt'), seen)], model: 'm',
        ctx: topCtx, signal: new AbortController().signal,
        agentId: 'child3', agentType: 'general-purpose',
      })
      // 围栏根若跟着变宽后的 ctx.cwd()（主仓库）走，主仓库内路径恒判"在围栏内"→ 静默放行；
      // 围栏根若正确锁定回合冻结的 worktreePath，则判"围栏外"→ 子代理侧拒。
      expect(seen.called).toBe(false)
    } finally {
      fs.rmSync(worktreeDir, { recursive: true, force: true })
      fs.rmSync(mainRepoDir, { recursive: true, force: true })
    }
  })

  it('对照：不 cd（cwd 未漂移）→ 围栏内写入正常放行（不打断现有能力）', async () => {
    const fenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toplevel-fence-ctrl-'))
    try {
      const parentSnap: PermissionSnapshot = { mode: 'default', rules: [], cwd: fenceRoot }
      const topCtx: ToolContext = {
        cwd: () => fenceRoot,
        setCwd: () => {},
        get signal() { return new AbortController().signal },
        fileState: new Map(),
        parentPermission: () => parentSnap,
      } as any
      const seen = { called: false }
      lastToolCallName = 'Write'
      await runSubagent({
        client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
        tools: [mkWriteStub(path.join(fenceRoot, 'ok.txt'), seen)], model: 'm',
        ctx: topCtx, signal: new AbortController().signal,
        agentId: 'child2', agentType: 'general-purpose',
      })
      expect(seen.called).toBe(true)
    } finally {
      fs.rmSync(fenceRoot, { recursive: true, force: true })
    }
  })
})
