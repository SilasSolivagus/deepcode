// src/tools/types.ts
import type { z } from 'zod'
import type { TaskListStore } from '../taskList.js'
import type { HookEvent, HookOutcome } from '../hooks.js'
import type { Decision, PermissionDecisionReason, PermissionSnapshot } from '../permissions.js'

export interface WorktreeSessionState {
  originalCwd: string
  worktreePath: string
  worktreeBranch: string
  headCommit: string
  gitRoot: string
  hookBased?: boolean
}

export interface WorktreeSession {
  get(): WorktreeSessionState | null
  set(s: WorktreeSessionState | null): void
}

export interface ToolContext {
  cwd: () => string
  setCwd: (dir: string) => void
  readonly signal: AbortSignal
  /** 绝对路径 -> mtimeMs。Read 记录；M2 的 Edit 用它强制 read-before-edit */
  fileState: Map<string, number>
  /** todo 任务清单 store（REPL/headless 注入；子代理不注入）。 */
  taskList?: TaskListStore
  /** /rewind before-image 钩子：Edit/Write 写盘前调，捕获文件原内容。子代理/headless 不注入（无快照）。 */
  recordBeforeImage?: (absPath: string) => void
  /** 子代理上下文标记：子代理保持纯执行，禁止起后台任务（防污染主会话通知队列）。 */
  isSubagent?: boolean
  /** 父级安全约束快照（子代理继承用）。主会话/headless/后台会话注入；
   *  子代理子 ctx **也注入**（值为子代理自己的快照），使约束逐层传递而非在第二层丢失。
   *  getter 形式：mode/cwd 等在会话中可变，必须每次现取。 */
  parentPermission?: () => PermissionSnapshot
  /** 向上转发权限确认到顶层注入点（交互式=真弹窗，无人值守=硬拒）。
   *  缺失即视为无人可问 → 子代理硬拒（fail-closed）。
   *  origin 标明请求来自哪个子代理，供顶层 UI 显示——顶层自身的 ask 不带此参。 */
  askUp?(
    toolName: string,
    desc: string,
    reason?: PermissionDecisionReason,
    previewRule?: string,
    origin?: { agentId: string; agentType: string },
  ): Promise<Decision>
  /** 子代理嵌套深度。顶层不注入 = 0；每下一层 +1。Agent 工具据此拒绝过深递归。 */
  subagentDepth?: number
  /** hooks 生命周期分派闭包（捕获会话 hooks 快照）。主会话与 headless 顶层 ctx 注入；子代理内部子 ctx 不注入。
   *  工具层事件（SubagentStart/Stop、①b-2 的 CwdChanged/Task/Notification）经此发事件。对空配置零开销返回空 outcome。 */
  hookDispatch?: (event: HookEvent, payload: Record<string, unknown>) => Promise<HookOutcome>
  /** 会话 ID（落盘文件 basename）。会话级事件 payload 的 session_id；①b-3 env-file 目录键。
   *  主会话/headless 顶层 ctx 注入；子代理子 ctx 不注入。getter 形式：resume/clear 换 session 后随之更新。 */
  sessionId?: () => string | undefined
  /** inline skill 注入：工具调用时把内容排进待注入队列，loop 在本轮 tool 结果回灌后作为 user 消息 flush。
   *  主会话/headless 顶层 ctx 注入；子代理子 ctx 不注入（forked skill 不嵌套注入）。 */
  injectUserMessage?: (content: string) => void
  /** deny 规则列表（Glob/Grep 过滤输出用）。主会话/headless 注入；子代理可不注入。 */
  denyPatterns?: () => string[]
  /** turn 内信号重建：steering 'now' 软中断后，旧 signal 已永久 aborted，
   *  调此重建 AbortController 使后续轮拿到未中断的新 signal。主会话/TUI 注入；headless/子代理不注入。 */
  resetSignal?: () => void
  /** 会话级活跃 worktree 状态（EnterWorktree/ExitWorktree 用）。主会话/headless 注入；子代理不注入。 */
  worktreeSession?: WorktreeSession
  /** 会话级 EnterWorktree 用；主会话/headless 注入 */
  worktreeConfig?: () => import('../worktree.js').WorktreeConfig | undefined
  /** 本执行体的工作目录围栏根：构造时定死、不随 cd 漂移。子代理注入自身 fenceRoot，
   *  供其再派子代理时继承——直接用 cwd() 会把已漂移的 subCwd 当围栏根，形成跨层逃逸。
   *  顶层会话不注入：其 cwd() 本身即围栏根。 */
  fenceRoot?: string
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  inputSchema: S
  /** MCP 工具：直接透传 server 给的 JSON Schema；toApiTools 优先用它，跳过 zodToJsonSchema。 */
  rawJsonSchema?: object
  /** 只读工具：自动放行权限 + 可并发执行 */
  isReadOnly: boolean
  /** false=无需确认；string=展示给用户的操作描述（权限规则的匹配对象） */
  needsPermission(input: z.infer<S>): false | string
  /** 本次调用会触碰的绝对路径（权限层 deny 检查用）。工具自管路径语义，无则不参与 deny。 */
  deniablePaths?(input: z.infer<S>, cwd: string): string[]
  /** 本次调用会访问的绝对路径集（工作目录围栏用）。文件工具实现之；无则不参与围栏。 */
  workspacePaths?(input: z.infer<S>, cwd: string): string[]
  call(input: z.infer<S>, ctx: ToolContext): Promise<string>
}
