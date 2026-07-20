// src/loop.ts
import type OpenAI from 'openai'
import { chatStream, type ChatResult, type ToolCall } from './api.js'
import type { Tool, ToolContext } from './tools/types.js'
import { toApiTools } from './tools/index.js'
import { checkPermission, type PermissionContext, type PermissionHooks } from './permissions.js'
import { sanitize, capToolResult, stripSystemReminderTags } from './text.js'
import { drainNotifications, formatNotification } from './tasks.js'
import { runHooks, classifyStopFailureError, type HooksConfig } from './hooks.js'
import { shouldContinueForBudget } from './tokenBudget.js'

/** 工具成败侧信道：活动日志需要 ok，但 ok 不该落盘、不该进 wire payload。 */
export const toolOk = new WeakMap<object, boolean>()

export type LoopEvent =
  | { type: 'text'; delta: string; reasoning?: boolean }
  | { type: 'tool_start'; id: string; name: string; desc: string }
  | { type: 'tool_end'; id: string; ok: boolean; preview: string; previewExtra: number; ms: number }
  | { type: 'turn_end'; usage: ChatResult['usage']; sentLen: number }

export interface LoopDeps {
  client: OpenAI
  tools: Tool<any>[]
  model: string
  thinking: boolean
  effortLevel?: 'low' | 'medium' | 'high'
  permission: PermissionContext
  ctx: ToolContext
  maxTurns?: number
  /** 每个含工具调用的 loop turn 在结果回灌前调用一次；返回的条目合并为一个 <system-reminder> 块
   *  附加到本轮最后一条 tool 消息末尾（只动最新后缀，不破坏 KV 缓存）。
   *  调用方可借此推进轮计数（如 TodoStore.tick）。
   *  供给函数不得抛异常（抛出会丢失该轮 usage 记录）。 */
  reminders?: () => string[]
  /** TUI 主会话注入：返回仍在连接（pending）的 MCP server 名。用于未知工具引用时提示模型调 WaitForMcpServers。 */
  pendingMcpServers?: () => string[]
  /** 仅主会话开启：到终止点（模型本轮无工具调用）时 drain 后台任务完成通知，
   *  有则作为 user 消息注入并续跑（受 maxTurns 约束）。默认 false —— 子代理子循环
   *  不得 drain 全局通知队列（否则会吞掉主会话的通知并误触续跑）。Task 6 在主会话调用处置 true。 */
  injectTaskNotifications?: boolean
  /** hooks 生命周期配置（会话启动快照）。仅主会话传入；子代理/webfetch 内部 loop 不传（①a）。 */
  hooks?: HooksConfig
  /** prompt/agent/http hook 运行时（llm/runAgent/fetch）。仅主会话传入；与 hooks 配对。 */
  hookDeps?: import('./hooks.js').HookEngineDeps
  /** inline skill 注入队列 drain：每轮 tool 结果回灌后调用，返回的内容各作 user 消息追加。
   *  与 ctx.injectUserMessage 接同一 buffer（caller 在 useChat/headless 接线）。 */
  drainInjections?: () => string[]
  /** steering 注入队列 drain：每轮 tool 结果回灌后、drainInjections 之后调用，
   *  返回已包 <queued-user-message> 标记的字符串，各作 user 消息追加。仅主会话（TUI）传入。 */
  drainSteering?: () => string[]
  /** 工具结果字符级兜底上限，超出截断后再回灌 messages（保护上下文/前缀缓存）。缺省由 caller 传 settings.maxToolResultChars。 */
  maxToolResultChars?: number
  /** 2.1 Token budget：本次 send 的输出 token 目标（用户 +500k 设的 sticky 值）。
   *  模型本轮自然结束但累计输出未达目标×90% 且仍有进展时，自动注入 nudge 续跑（受 maxTurns + 收益递减熔断约束）。
   *  仅主会话传入；子代理子循环不传（不参与 budget 续跑）。*/
  tokenBudget?: number
  /** /goal 停止前自检门：模型无工具调用即将停止时调用。返回 {continue:true,inject} → 注入 inject 作 user 消息续跑；
   *  {continue:false} → 放行停止。无 activeGoal / judge 故障 / 达成 / 不可达 / 迭代上限均返回 continue:false（fail-safe 放行）。
   *  仅主会话传入；子代理子循环不传。 */
  goalGate?: (messages: any[]) => Promise<{ continue: true; inject: string } | { continue: false }>
}

const CONCURRENCY = 5

/** 正文泄漏工具调用意图的保守标记：只认明确的工具调用开标签，正常正文极少出现，误报低。 */
const TOOL_LEAK_RE = /<\s*(invoke|function_calls|tool_call|tool_use|antml:invoke)\b/i

/** 取最近 n 条 role:'tool' message 的内容拼接，截断到 maxChars（为 classify 提供兄弟上下文快照）。*/
export function buildRecentContext(messages: any[], n: number, maxChars: number): string {
  const tools = messages.filter(m => m.role === 'tool').slice(-n).map(m => String(m.content ?? ''))
  return tools.join('\n---\n').slice(0, maxChars)
}

/** 退出 loop 前调用：若 messages 以 tool 结尾，补一条收尾 assistant，保证下一轮 user 消息序列合法 */
function sealMessages(messages: any[], note: string): void {
  if (messages[messages.length - 1]?.role === 'tool') {
    messages.push({ role: 'assistant', content: note })
  }
}

/** 工具结果预览（⎿ 下显示前几行内容 + 「… +N 行」）：取前 MAXLINES 行，
 *  各行先剥控制字符再按 200 字截断（先 split 再 sanitize——sanitize 剥 \n，整体清洗会并成一行）。
 *  返回展示文本（多行 \n 连接）与剩余行数 extra。*/
function previewOf(content: string): { text: string; extra: number } {
  const MAXLINES = 6
  const lines = content.replace(/\n+$/, '').split('\n')  // 去尾部空行，避免虚增行数
  const shown = lines.slice(0, MAXLINES).map(l => {
    const s = sanitize(l)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  })
  return { text: shown.join('\n'), extra: Math.max(0, lines.length - MAXLINES) }
}

/** best-effort 解析 tool_calls 的 arguments 字符串；失败保留原串（供 PostToolBatch payload）。 */
function safeParseArgs(s: string): unknown {
  try { return JSON.parse(s || '{}') } catch { return s }
}

/** 未知工具名的回灌文案。若是某 pending MCP server 的工具，提示等待而非报「不存在」。 */
export function unknownToolMessage(name: string, toolNames: string[], pending: string[]): string {
  const m = /^mcp__(.+?)__/.exec(name)
  if (m && pending.includes(m[1])) {
    return `工具 ${name} 暂不可用：MCP server '${m[1]}' 仍在连接中。调用 WaitForMcpServers 等待其就绪后重试。`
  }
  return `错误：工具 ${name} 不存在。可用工具：${toolNames.join(', ')}`
}

/** ms 只计 tool.call 的实际执行时间，不含权限等待等前置环节；前置环节出错时 ms 为 0 */
async function execCall(call: ToolCall, deps: LoopDeps): Promise<{ ok: boolean; content: string; ms: number; retryHint?: boolean }> {
  const tool = deps.tools.find(t => t.name === call.name)
  if (!tool) {
    return { ok: false, content: unknownToolMessage(call.name, deps.tools.map(t => t.name), deps.pendingMcpServers?.() ?? []), ms: 0 }
  }
  let raw: unknown
  try { raw = JSON.parse(call.args || '{}') } catch {
    return { ok: false, content: '错误：参数不是合法 JSON。请重新发起本次工具调用，确保 arguments 是完整 JSON 对象。', ms: 0 }
  }
  const parsed = tool.inputSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { ok: false, content: `错误：参数不符合 schema：${issues}`, ms: 0 }
  }
  let input = parsed.data
  const cwd = deps.ctx.cwd()

  // —— PreToolUse hook（权限检查前）——
  let preAllow = false
  if (deps.hooks) {
    const descMaybe = tool.needsPermission(input)
    const pre = await runHooks('PreToolUse', {
      hook_event_name: 'PreToolUse', cwd, tool_name: tool.name, tool_input: input,
      tool_desc: typeof descMaybe === 'string' ? descMaybe : '',
    }, deps.hooks, deps.hookDeps)
    if (pre.block) return { ok: false, content: `PreToolUse hook 阻止本次调用：${pre.blockReason ?? ''}`, ms: 0 }
    if (pre.updatedInput !== undefined) {
      const re = tool.inputSchema.safeParse(pre.updatedInput)
      if (!re.success) return { ok: false, content: 'PreToolUse hook 的 updatedInput 不符合工具 schema，已拒绝执行。', ms: 0 }
      input = re.data
    }
    preAllow = pre.permission === 'allow'
  }

  if (!preAllow) {
    let retryRequested = false
    const permHooks = deps.hooks ? {
      onRequest: (name: string, d: string) =>
        runHooks('PermissionRequest', { hook_event_name: 'PermissionRequest', cwd, tool_name: name, tool_desc: d }, deps.hooks, deps.hookDeps),
      onDenied: async (name: string, d: string, reason: string) => {
        const out = await runHooks('PermissionDenied', { hook_event_name: 'PermissionDenied', cwd, tool_name: name, tool_input: input, tool_use_id: call.id, tool_desc: d, reason }, deps.hooks, deps.hookDeps)
        if (out.retry) retryRequested = true
      },
    } : undefined
    const perm = await checkPermission(tool, input, deps.permission, permHooks)
    if (!perm.ok) return { ok: false, content: perm.reason, ms: 0, retryHint: retryRequested }
  }

  const t0 = Date.now()
  try {
    let content = await tool.call(input, deps.ctx)
    if (deps.hooks) {
      const post = await runHooks('PostToolUse', {
        // 标准字段名为 tool_response；保留 tool_output 作向后兼容别名。
        hook_event_name: 'PostToolUse', cwd, tool_name: tool.name, tool_input: input,
        tool_response: content, tool_output: content, tool_use_id: call.id, duration_ms: Date.now() - t0,
      }, deps.hooks, deps.hookDeps)
      if (post.updatedOutput !== undefined) content = post.updatedOutput
      if (post.additionalContext) content += `\n\n<hook-context>\n${post.additionalContext}\n</hook-context>`
    }
    content = capToolResult(content, deps.maxToolResultChars ?? 100_000)
    return { ok: true, content, ms: Date.now() - t0 }
  } catch (e: any) {
    let content = `错误：${e?.message ?? String(e)}`
    if (deps.hooks) {
      const fail = await runHooks('PostToolUseFailure', {
        hook_event_name: 'PostToolUseFailure', cwd, tool_name: tool.name, tool_input: input, error: content,
        tool_use_id: call.id, duration_ms: Date.now() - t0,
      }, deps.hooks, deps.hookDeps)
      if (fail.additionalContext) content += `\n\n<hook-context>\n${fail.additionalContext}\n</hook-context>`
    }
    return { ok: false, content, ms: Date.now() - t0 }
  }
}

export async function* runLoop(
  messages: any[],
  deps: LoopDeps,
): AsyncGenerator<LoopEvent, 'done' | 'aborted' | 'max_turns'> {
  const apiTools = toApiTools(deps.tools)
  deps.permission.recentContext = () => buildRecentContext(messages, 2, 4000)
  let stopHookFired = false // Stop hook block→续跑守卫：每次 runLoop 最多续跑一次，硬防无限循环
  let malformedRetryFired = false // malformed-tool-use clean-retry 守卫：每次 runLoop 最多重试一次
  // 2.1 Token budget 续跑状态（本次 runLoop=一次 send 内累计；不跨 send）
  let budgetOutputSoFar = 0
  let budgetContinuations = 0
  const budgetDeltas: number[] = []
  for (let turn = 0; turn < (deps.maxTurns ?? 80); turn++) {
    const sentLen = messages.length
    let result: ChatResult
    let streamedText = ''
    try {
      const stream = chatStream(deps.client, {
        model: deps.model,
        messages,
        tools: apiTools,
        thinking: deps.thinking,
        effortLevel: deps.effortLevel,
        signal: deps.ctx.signal,
      })
      while (true) {
        const step = await stream.next()
        if (step.done) {
          result = step.value
          break
        }
        yield {
          type: 'text',
          delta: step.value.delta,
          ...(step.value.type === 'reasoning' ? { reasoning: true } : {}),
        }
        if (step.value.type !== 'reasoning') streamedText += step.value.delta
      }
    } catch (e) {
      if (deps.ctx.signal.aborted) {
        // steering 软中断：保留已生成 partial、重建 signal、注入 steering、续跑（不终止）
        // 注：当前用户 steering 路径只在 toolInFlight 时 abort，故 mid-stream 中断分支当前仅为将来 SDK
        // now 优先级预留；Enter 路径走不到这里（纯流式 toolsRunning=0 不 abort）。
        if (deps.ctx.signal.reason === 'interrupt') {
          if (streamedText) messages.push({ role: 'assistant', content: streamedText })
          deps.ctx.resetSignal?.()
          for (const s of deps.drainSteering?.() ?? []) messages.push({ role: 'user', content: s })
          continue
        }
        // 硬中断（ESC user-cancel 或无 reason）：维持现状
        sealMessages(messages, '（本轮已被用户中断。）')
        return 'aborted'
      }
      // StopFailure hook：API 调用异常（非用户中断）。记录/通知用途，await 完成后继续抛（不改变控制流）。
      if (deps.hooks) {
        await runHooks('StopFailure', {
          hook_event_name: 'StopFailure',
          cwd: deps.ctx.cwd(),
          error: classifyStopFailureError(e),
          error_details: (e as any)?.message ?? String(e),
          last_assistant_message: streamedText,
        }, deps.hooks, deps.hookDeps)
      }
      throw e
    }

    messages.push({
      role: 'assistant',
      content: result.content || null,
      ...(result.toolCalls.length
        ? {
            tool_calls: result.toolCalls.map(c => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.args },
            })),
          }
        : {}),
    })
    // 2.1 Token budget：累计本次 send 全部 output token（含 tool-call turn 的 reasoning+参数）
    budgetOutputSoFar += result.usage.completion_tokens
    budgetDeltas.push(result.usage.completion_tokens)
    if (!result.toolCalls.length) {
      yield { type: 'turn_end', usage: result.usage, sentLen }
      // malformed-tool-use 自愈：模型把工具调用写进正文却没产生有效 tool_call → 单次重试
      if (!malformedRetryFired && result.finishReason !== 'length'
          && typeof result.content === 'string' && TOOL_LEAK_RE.test(result.content)) {
        malformedRetryFired = true
        messages.push({ role: 'user', content: '（上一条回复未能产生有效的工具调用，疑似把工具调用写进了正文。请用真正的工具调用机制重新发起本次调用，不要把调用写成正文文本。）' })
        continue
      }
      // 被长度上限截断且无工具调用：自动追加续写请求，进入下一轮（仍受 maxTurns 约束）
      if (result.finishReason === 'length') {
        messages.push({ role: 'user', content: '（上一条回复因长度上限被截断，请继续输出剩余内容。）' })
        continue
      }
      // 2.1 Token budget 续跑：未达目标×90% 且仍有进展（收益未递减）→ 注入 nudge 续跑。
      // 在 length 截断之后（截断必续写优先、其 continue 已跳过此处不会双重注入），任务通知之前。
      if (deps.tokenBudget && shouldContinueForBudget({
        budget: deps.tokenBudget, outputSoFar: budgetOutputSoFar,
        continuations: budgetContinuations, lastDeltas: budgetDeltas,
      })) {
        budgetContinuations++
        messages.push({ role: 'user', content: '（继续——尚未达到本次 token 预算，请接着完成未尽工作，不要总结收尾。）' })
        continue
      }
      // 模型本轮无工具调用：主会话先看有没有后台任务完成通知要注入（子代理子循环不参与）
      if (deps.injectTaskNotifications) {
        const notes = drainNotifications()
        if (notes.length > 0) {
          messages.push({ role: 'user', content: notes.map(formatNotification).join('\n') })
          continue // 不 return，进入下一轮 turn（再发一次 API，模型据通知决策；受 maxTurns 约束）
        }
      }
      // steering（no-tool turn-end）：模型本轮无工具调用自然结束时，若有排队的 steering 消息，注入并续跑。
      // turn 结束时消费排队消息；tool 边界那段 drainSteering 仍独立工作，两路互不重复（drain 清空队列）。
      const steerMsgs = deps.drainSteering?.() ?? []
      if (steerMsgs.length > 0) {
        for (const s of steerMsgs) messages.push({ role: 'user', content: s })
        continue
      }
      // Stop hook：即将自然结束前触发——
      // preventContinuation（decision:block / exit2）→ 注入 blockReason 作 user 消息续跑（守卫限一次）；
      // 读 preventContinuation/stop 而非 block（block 在 permission 通道也为真，语义重载，见 ①a 终审 I-1）。
      if (deps.hooks) {
        const lastAssistant = messages[messages.length - 1] // 本路径 !toolCalls.length，tail 必为刚推入的 assistant
        const stop = await runHooks('Stop', {
          hook_event_name: 'Stop',
          cwd: deps.ctx.cwd(),
          // 首次触发时 stopHookFired=false；续跑后重入本路径时已为 true → hook 据此知「本轮系上次续跑触发」。
          stop_hook_active: stopHookFired,
          last_assistant_message: typeof lastAssistant?.content === 'string' ? lastAssistant.content : '',
        }, deps.hooks, deps.hookDeps)
        // continue:false（硬停）优先于 block 续跑：即便另一 hook 要续跑，continue:false 也压倒之，直接结束。
        if (stop.stop) return 'done'
        if (stop.preventContinuation && !stopHookFired) {
          stopHookFired = true
          messages.push({ role: 'user', content: stop.blockReason ?? '（Stop hook 要求继续未尽事项）' })
          continue
        }
      }
      // /goal 停止前自检：Stop hook 之后、真正停止之前。gate 内部跑 fast judge，未达成则注入续跑。
      // 无 once-guard（与 Stop hook 不同）——目标未达成前每次想停都要重判。
      if (deps.goalGate) {
        const g = await deps.goalGate(messages)
        if (g.continue) { messages.push({ role: 'user', content: g.inject }); continue }
      }
      return 'done'
    }

    // 只读并发（上限 5），非只读串行；未知工具默认归入只读批（execCall 会返回错误结果）
    const outcomes = new Map<string, { ok: boolean; content: string; ms: number; retryHint?: boolean }>()
    const isRO = (c: ToolCall) => deps.tools.find(t => t.name === c.name)?.isReadOnly ?? true
    const ro = result.toolCalls.filter(isRO)
    const rw = result.toolCalls.filter(c => !isRO(c))

    for (const c of ro) yield { type: 'tool_start', id: c.id, name: c.name, desc: c.args }
    for (let i = 0; i < ro.length; i += CONCURRENCY) {
      const batch = ro.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(c => execCall(c, deps)))
      batch.forEach((c, j) => outcomes.set(c.id, results[j]))
    }
    for (const c of ro) {
      const o = outcomes.get(c.id)!
      const pv = previewOf(o.content)
      yield { type: 'tool_end', id: c.id, ok: o.ok, preview: pv.text, previewExtra: pv.extra, ms: o.ms }
    }

    for (const c of rw) {
      yield { type: 'tool_start', id: c.id, name: c.name, desc: c.args }
      if (deps.ctx.signal.aborted) outcomes.set(c.id, { ok: false, content: '已被用户中断，未执行', ms: 0 })
      else outcomes.set(c.id, await execCall(c, deps))
      const o = outcomes.get(c.id)!
      const pv = previewOf(o.content)
      yield { type: 'tool_end', id: c.id, ok: o.ok, preview: pv.text, previewExtra: pv.extra, ms: o.ms }
    }

    // 工具结果必须按原始 tool_calls 顺序回灌
    for (const c of result.toolCalls) {
      const o = outcomes.get(c.id)!
      const msg = { role: 'tool', tool_call_id: c.id, content: stripSystemReminderTags(o.content) }
      toolOk.set(msg, o.ok)          // ← 侧信道，不加字段
      messages.push(msg)
    }
    // PostToolBatch hook：本批工具全 resolve 后触发一次（下轮请求前）。additionalContext 附最后一条 tool 消息。
    if (deps.hooks) {
      const batch = await runHooks('PostToolBatch', {
        hook_event_name: 'PostToolBatch',
        cwd: deps.ctx.cwd(),
        tool_calls: result.toolCalls.map(c => ({
          tool_name: c.name,
          tool_input: safeParseArgs(c.args),
          tool_use_id: c.id,
          tool_response: outcomes.get(c.id)!.content,
        })),
      }, deps.hooks, deps.hookDeps)
      if (batch.additionalContext) {
        const last = messages[messages.length - 1] // 刚 push 完 tool 结果，tail 必为 tool
        last.content += `\n\n<hook-context>\n${batch.additionalContext}\n</hook-context>`
      }
    }
    // system-reminder：附加到本轮最后一条 tool 消息（即将发送的最新后缀）
    const notes = deps.reminders?.() ?? []
    if (notes.length) {
      const last = messages[messages.length - 1] // 上面刚推完 tool 消息，必为 tool
      last.content += `\n\n<system-reminder>\n${notes.join('\n\n')}\n</system-reminder>`
    }
    // inline skill：把工具经 injectUserMessage 排入的内容作为 user 消息追加（在 tool 结果之后，下一轮模型可见）
    for (const inj of deps.drainInjections?.() ?? []) {
      messages.push({ role: 'user', content: inj })
    }
    // steering（next/later）：用户中途排队的消息在 tool 结果边界注入（已含 queued-user-message 标记）
    for (const s of deps.drainSteering?.() ?? []) {
      messages.push({ role: 'user', content: s })
    }
    // PermissionDenied retry：hook 返回 retry:true → 额外推 meta 消息告知模型可重试（工具不自动重跑）
    for (const c of result.toolCalls) {
      if (outcomes.get(c.id)?.retryHint) {
        messages.push({ role: 'user', content: 'The PermissionDenied hook indicated you may retry this tool call.' })
      }
    }
    yield { type: 'turn_end', usage: result.usage, sentLen }
    if (deps.ctx.signal.aborted) {
      // mid-tool 软中断：assistant+tool 结果已在 messages（进度天然保留），重建 signal+注入 steering 续跑
      if (deps.ctx.signal.reason === 'interrupt') {
        deps.ctx.resetSignal?.()
        for (const s of deps.drainSteering?.() ?? []) messages.push({ role: 'user', content: s })
        continue
      }
      sealMessages(messages, '（本轮已被用户中断。）')
      return 'aborted'
    }
  }
  sealMessages(messages, '（已达最大轮数上限，已停止。）')
  return 'max_turns'
}
