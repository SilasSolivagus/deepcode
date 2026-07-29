// src/tools/agent.ts
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool } from './types.js'
import type { Usage } from '../api.js'
import { allTools } from './index.js'
import { makeWebFetchTool } from './webfetch.js'
import { resolveSubModel } from '../providers.js'
import { WORKSPACE_FENCE_REASON, WORKFLOW_USAGE_CONFIRM_REASON, YOLO_DANGEROUS_CONFIRM_REASON, type PermissionDecisionReason } from '../permissions.js'
import { BUILTIN_AGENTS, GLOBAL_SUBAGENT_DENY, resolveAgentTools, buildAgentDescription, type AgentDefinition } from './agentTypes.js'
import { generateTaskId, registerTask, updateTask, getTask, enqueueNotification } from '../tasks.js'
import { taskOutputPath } from '../config.js'
import { runSubagent } from '../subagentRunner.js'
import { resolveGitRoot, createWorktree, worktreeChanges, removeWorktree, type WorktreeConfig, type WorktreeHandle } from '../worktree.js'

/** 子代理嵌套深度上限：主 → 子 → 孙，孙再派即拒。防 general-purpose 递归 fork 失控。 */
export const MAX_SUBAGENT_DEPTH = 2

/** 这些 reason 来源意味着"本该由人拍板"。子代理无审批 UI，无人可批 → 拒。 */
export function isSecurityGate(reason?: PermissionDecisionReason): boolean {
  if (!reason) return false
  if (reason.type === 'rule') return reason.rule.behavior === 'deny' || reason.rule.behavior === 'ask'
  if (reason.type === 'classifier') return reason.decision === 'ask' || reason.decision === 'block'
  if (reason.type === 'other') {
    return reason.reason === WORKSPACE_FENCE_REASON
      || reason.reason.startsWith('保护路径守卫')
      // workflow 用量确认天然属于"本该由人拍板"：当前因 Workflow 在 GLOBAL_SUBAGENT_DENY 里
      // 不可达而从未真正触发，补上是为了去掉这层隐性依赖（不依赖"恰好不可达"这条件）。
      || reason.reason === WORKFLOW_USAGE_CONFIRM_REASON
      // yolo 危险命令确认同属"本该由人拍板"。今天该门只在 isDangerous(desc) 为真时触发，
      // 而 buildSubagentPermission 的第二档兜底也正是 isDangerous 判定，故行为上是 no-op；
      // 补上是为了不依赖"恰好被兜底覆盖"这条件（同 workflow 用量确认的理由）。
      || reason.reason === YOLO_DANGEROUS_CONFIRM_REASON
  }
  return false
}

const schema = z.object({
  description: z.string().describe('任务的一句话描述（显示给用户）'),
  prompt: z.string().describe('给子代理的完整任务指令。子代理看不到当前对话，指令必须自包含（含路径、要找什么、期望输出）'),
  subagent_type: z.string().optional().describe('专才子代理类型；省略=general-purpose'),
  run_in_background: z.boolean().optional().describe('设为 true 在后台运行子代理；完成时通知你'),
  isolation: z.enum(['worktree']).optional().describe('隔离模式。"worktree" 在临时 git worktree 里跑子代理，给它仓库的隔离副本。无改动自动清理；有改动则返回 worktree 路径与分支。'),
})


export function makeAgentTool(deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void; getModel: () => string; agents?: AgentDefinition[]; worktree?: WorktreeConfig }): Tool<typeof schema> {
  // WebFetch 只建一次（别每次 call 重建）。
  const webFetch = makeWebFetchTool({ client: deps.client, onUsage: deps.onUsage })
  const agents = deps.agents ?? BUILTIN_AGENTS
  const tool: Tool<typeof schema> = {
    name: 'Agent',
    description: buildAgentDescription(agents),
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx) {
      // 子代理工具池 = 主工具集 + WebFetch + Agent 自身（子代理可递归派子代理）。
      // 自引用闭包：call 运行时 tool 已赋值。Explore/Plan 靠 disallowedTools 含 'Agent' 仍不递归。
      const pool: Tool<any>[] = [...allTools, webFetch, tool]
      const type = input.subagent_type ?? 'general-purpose'
      const def = agents.find(a => a.agentType === type)
      if (!def) {
        const available = agents.map(a => a.agentType).join(', ')
        throw new Error(`Agent type '${type}' not found. Available: ${available}`)
      }
      if ((ctx.subagentDepth ?? 0) >= MAX_SUBAGENT_DEPTH) {
        throw new Error(`子代理嵌套已达上限 ${MAX_SUBAGENT_DEPTH} 层，不能再派子代理。请在当前层完成剩余工作。`)
      }
      const tools = resolveAgentTools(def, pool, GLOBAL_SUBAGENT_DENY)
      const subModel =
        resolveSubModel(def.model, deps.getModel())

      const wantWorktree = input.isolation === 'worktree'

      // 建 worktree（git 路径正常建；非 git 时尝试 WorktreeCreate hook 兜底；hook 也没有 → 抛错）
      async function setupWorktree(agentId: string): Promise<WorktreeHandle | null> {
        if (!wantWorktree) return null
        const root = await resolveGitRoot(ctx.cwd())
        if (!root) {
          const name = `agent-${agentId.slice(1, 9)}`
          const out = await ctx.hookDispatch?.('WorktreeCreate', { hook_event_name: 'WorktreeCreate', name })
          const hookPath = out?.additionalContext?.trim()
          if (hookPath) return { worktreePath: hookPath, worktreeBranch: '', headCommit: '', gitRoot: '', hookBased: true }
          throw new Error('isolation:"worktree" 需要 git 仓库（或配置 WorktreeCreate hook）。当前目录不是 git 仓库。')
        }
        return createWorktree(root, `agent-${agentId.slice(1, 9)}`, deps.worktree)
      }

      // 收尾：hookBased → 一律保留；git 路径：无改动删、有改动留并回传
      async function teardownWorktree(wt: WorktreeHandle | null, final: string | undefined): Promise<string> {
        if (!wt) return final ?? '（子代理无输出）'
        if (wt.hookBased) return `${final ?? '（子代理无输出）'}\n\n[worktree] 改动保留在 ${wt.worktreePath}（hook-based）。`
        const ch = await worktreeChanges(wt.worktreePath, wt.headCommit)
        if (ch.changedFiles === 0 && ch.commits === 0) { await removeWorktree(wt); return final ?? '（子代理无输出）' }
        return `${final ?? '（子代理无输出）'}\n\n[worktree] 改动保留在 ${wt.worktreePath}（分支 ${wt.worktreeBranch}）。`
      }

      // 后台路径：脱钩跑、立即返句柄。
      // 子代理保持纯执行：忽略 run_in_background，降级为前台同步执行（防污染主会话通知队列）。
      if (input.run_in_background === true && !ctx.isSubagent) {
        const id = generateTaskId('local_agent')
        const ac = new AbortController()
        const outputFile = taskOutputPath(id)
        fs.mkdirSync(path.dirname(outputFile), { recursive: true })
        registerTask({
          id, type: 'local_agent', status: 'running',
          description: input.description, prompt: input.prompt,
          abortController: ac, outputFile, outputOffset: 0, notified: false,
          startTime: Date.now(),
        })
        ctx.hookDispatch?.('TaskCreated', { hook_event_name: 'TaskCreated', task_kind: 'background', task_id: id, task_description: input.description }).catch(() => {})
        void (async () => {
          let wt: WorktreeHandle | null = null
          try {
            wt = await setupWorktree(id)
            const final = await runSubagent({
              client: deps.client, onUsage: deps.onUsage,
              systemPrompt: def.getSystemPrompt(), userPrompt: input.prompt,
              tools, model: subModel, outputSchema: def.outputSchema,
              ctx, signal: ac.signal, agentId: id, agentType: type,
              worktreePath: wt?.worktreePath,
            })
            // runLoop 在 abort 时是 return 'aborted'（不抛错），runSubagent 仍正常返回——
            // 必须显式查 ac.signal.aborted，否则被 TaskStop 中断的子代理会被误标 completed。
            if (ac.signal.aborted) {
              if (wt && !wt.hookBased) await removeWorktree(wt).catch(() => {})
              updateTask(id, { status: 'killed', endTime: Date.now() })
            } else {
              const result = await teardownWorktree(wt, final)
              fs.writeFileSync(outputFile, result)
              updateTask(id, { status: 'completed', endTime: Date.now(), result })
            }
          } catch {
            if (wt && !wt.hookBased) await removeWorktree(wt).catch(() => {})
            updateTask(id, { status: ac.signal.aborted ? 'killed' : 'failed', endTime: Date.now() })
          } finally {
            enqueueNotification(getTask(id)!)
            ctx.hookDispatch?.('TaskCompleted', { hook_event_name: 'TaskCompleted', task_kind: 'background', task_id: id, status: getTask(id)!.status }).catch(() => {})
          }
        })()
        return `后台子代理已启动 id=${id}（类型 ${type}）。完成时会通知你。`
      }

      // 前台路径（默认）：删信号量后直接跑（并发由 loop CONCURRENCY 只读批约束）。
      const fgId = generateTaskId('local_agent')
      const wt = await setupWorktree(fgId)
      let final: string | undefined
      try {
        final = await runSubagent({
          client: deps.client, onUsage: deps.onUsage,
          systemPrompt: def.getSystemPrompt(), userPrompt: input.prompt,
          tools, model: subModel, outputSchema: def.outputSchema,
          ctx, signal: ctx.signal, agentId: fgId, agentType: type,
          worktreePath: wt?.worktreePath,
        })
      } catch (e) { if (wt && !wt.hookBased) await removeWorktree(wt).catch(() => {}); throw e }
      return teardownWorktree(wt, final)
    },
  }
  return tool
}
