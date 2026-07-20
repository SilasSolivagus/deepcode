// src/workflow/backend.ts
import type OpenAI from 'openai'
import crypto from 'node:crypto'
import { z } from 'zod'
import type { ToolContext, Tool } from '../tools/types.js'
import type { Usage } from '../api.js'
import type { AgentSpec, AgentEffort } from './types.js'
import { BUILTIN_AGENTS, GLOBAL_SUBAGENT_DENY, resolveAgentTools, type AgentDefinition } from '../tools/agentTypes.js'
import { resolveGitRoot, createWorktree, worktreeChanges, removeWorktree, type WorktreeConfig, type WorktreeHandle } from '../worktree.js'

export interface WorkflowBackend {
  runAgent(spec: AgentSpec): Promise<{ status: 'ok' | 'error'; result: unknown; worktree?: { path: string; branch: string } }>
}

export function mapEffort(e?: AgentEffort): 'low' | 'medium' | 'high' | undefined {
  if (!e) return undefined
  if (e === 'xhigh' || e === 'max') return 'high'
  return e
}

export interface InProcessBackendDeps {
  runSubagent: (opts: any) => Promise<string | undefined>
  sessionModel: string
  client: OpenAI
  onUsage: (u: Usage, model: string) => void
  ctx: ToolContext
  signal: AbortSignal
  agents: AgentDefinition[]
  toolPool?: Tool<any>[]
  resolveModelAlias?: (m: string) => string
  worktree?: WorktreeConfig
}

/** 单实现：包 runSubagent，一次性 runAgent(spec)→结果。isolation:'remote' 拒（本地实现不支持远程隔离）。 */
export function makeInProcessBackend(deps: InProcessBackendDeps): WorkflowBackend {
  return {
    async runAgent(spec) {
      if (spec.opts.isolation === 'remote') {
        throw new Error("agent({isolation:'remote'}) is not available in this build.")
      }
      const effortLevel = mapEffort(spec.opts.effort)
      const model = spec.opts.model ? (deps.resolveModelAlias?.(spec.opts.model) ?? spec.opts.model) : deps.sessionModel
      const agentType = spec.opts.agentType ?? 'general-purpose'
      const def = deps.agents.find(a => a.agentType === agentType)
      const resolvedDef = def ?? BUILTIN_AGENTS.find(a => a.agentType === 'general-purpose') ?? BUILTIN_AGENTS[0]
      const systemPrompt = def?.getSystemPrompt() ?? ''
      // schema：JSON Schema → 这里 v1 用 zod 透传层；若 def 有 outputSchema 用之，否则把 JSON Schema 包成 z.any 校验占位
      const outputSchema = spec.opts.schema ? z.any() : def?.outputSchema
      const resolvedTools = resolveAgentTools(resolvedDef, deps.toolPool ?? [], GLOBAL_SUBAGENT_DENY)

      // worktree 隔离（镜像 tools/agent.ts；非 git+无 hook 时 workflow 降级为 error，不抛；
      // 创建失败（分支撞名/磁盘/权限等）同样降级为 error，绝不让 runAgent 抛出）
      let wt: WorktreeHandle | null = null
      if (spec.opts.isolation === 'worktree') {
        try {
          const root = await resolveGitRoot(deps.ctx.cwd())
          if (root) {
            const name = `agent-${spec.agentId.slice(1, 9)}-${crypto.randomBytes(3).toString('hex')}`
            wt = await createWorktree(root, name, deps.worktree)
          } else {
            const out = await deps.ctx.hookDispatch?.('WorktreeCreate', { hook_event_name: 'WorktreeCreate', name: `agent-${spec.agentId.slice(1, 9)}` })
            const hookPath = out?.additionalContext?.trim()
            if (hookPath) wt = { worktreePath: hookPath, worktreeBranch: '', headCommit: '', gitRoot: '', hookBased: true }
            else return { status: 'error', result: null }
          }
        } catch {
          if (wt && !wt.hookBased) await removeWorktree(wt).catch(() => {})
          return { status: 'error', result: null }
        }
      }

      try {
        const raw = await deps.runSubagent({
          client: deps.client, onUsage: deps.onUsage, systemPrompt, userPrompt: spec.prompt,
          tools: resolvedTools, model, outputSchema, ctx: deps.ctx, signal: deps.signal,
          agentId: spec.agentId, agentType,
          worktreePath: wt?.worktreePath,
          thinking: effortLevel !== undefined, effortLevel,
        })
        const result = spec.opts.schema && raw ? JSON.parse(raw) : raw
        let worktree: { path: string; branch: string } | undefined
        if (wt) {
          if (wt.hookBased) {
            worktree = { path: wt.worktreePath, branch: '' } // hook-based 一律保留
          } else {
            const ch = await worktreeChanges(wt.worktreePath, wt.headCommit)
            if (ch.changedFiles === 0 && ch.commits === 0) await removeWorktree(wt)
            else worktree = { path: wt.worktreePath, branch: wt.worktreeBranch }
          }
        }
        return { status: 'ok', result: result ?? null, worktree }
      } catch {
        if (wt && !wt.hookBased) await removeWorktree(wt).catch(() => {})
        return { status: 'error', result: null }
      }
    },
  }
}
