// src/config.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HOOK_EVENTS, type HooksConfig, type HookEvent, runHooks } from './hooks.js'
import { loadLayeredSettings } from './settingsLayers.js'
import { parseMemoryConfig } from './memdir/memoryConfig.js'
import { resolveNotifChannel, type NotifChannel } from './notify.js'
import { anyProviderKeyReady, type CustomProvider, type ModelMeta, type ProviderId } from './providers.js'
import type { PermissionMode } from './permissions.js'

export interface McpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface SkillsConfig {
  /** 扫哪些目录家族；缺省 = 两者都扫。
   *  'claude' = <home|proj>/.claude/skills；'deepcode' = <home|proj>/.deepcode/{skills,commands}。
   *  ['deepcode'] 一刀切跳过所有 .claude 源（干掉 ~/.claude 的 gstack 灌入）。 */
  sources?: Array<'claude' | 'deepcode'>
  /** 按精确 skill 名排除（不加载→不在任何清单、不可调用）。 */
  deny?: string[]
  /** 模型清单 + Skill 工具 description 的总字符预算；缺省 8000。 */
  listingBudgetChars?: number
}

export interface WebSearchSettings {
  bocha?: { apiKey?: string }
  tavily?: { apiKey?: string }
  /** 向后兼容字段，双源并查不使用。 */
  provider?: string
  anysearch?: { enabled?: boolean; apiKey?: string }
}

export interface Settings {
  permissions: { allow: string[]; deny?: string[]; ask?: string[]; defaultMode?: PermissionMode }
  /** 自动 compact 触发阈值（上次请求的 prompt_tokens 超过即触发；undefined = 走派生阈值） */
  compactTokens?: number
  /** 启用预处理 compaction（缺省 true；仅 === false 关闭） */
  precomputeCompactionEnabled?: boolean
  /** 本会话花费提醒阈值（CNY，状态行变色一次） */
  costWarnCNY: number
  /** 工具结果字符级兜底上限，超出截断后再回灌 messages（保护上下文/前缀缓存）。缺省 100,000。 */
  maxToolResultChars: number
  /** 启动默认模型（undefined = 内置缺省 deepseek-v4-flash） */
  model?: string
  /** 输出风格名（undefined = 不注入特殊风格；'default' 同) */
  outputStyle?: string
  /** 响应语言锁定：设了就往系统提示注入「始终用 X 回复」。undefined = 不锁定。 */
  language?: string
  /** 会话历史保留天数（cleanupPeriodDays）：启动时删除超龄 .jsonl 会话。undefined/≤0 = 不清理。 */
  cleanupPeriodDays?: number
  /** 自定义 API baseURL（undefined = https://api.deepseek.com） */
  baseURL?: string
  /** DeepSeek API key（首跑向导写入；env DEEPSEEK_API_KEY 优先级更高） */
  apiKey?: string
  /** active provider 选择（缺省 deepseek）。仅信任 user scope（project 剥离，见 settingsLayers）。 */
  provider?: 'deepseek' | 'glm' | 'kimi' | 'custom'
  /** per-provider 覆盖（apiKey）+ custom 后端定义。仅信任 user scope。 */
  providers?: {
    deepseek?: { apiKey?: string }
    glm?: { apiKey?: string }
    kimi?: { apiKey?: string }
    custom?: CustomProvider
  }
  /** 启动用内联模式（退回非全屏 TUI；env DEEPCODE_INLINE=1 / CLI --inline 优先） */
  inline?: boolean
  /** hooks 生命周期配置（会话启动快照；见 src/hooks.ts） */
  hooks?: HooksConfig
  /** MCP server 配置（stdio）。键=server 名，值=启动方式。 */
  mcpServers?: Record<string, McpStdioServerConfig>
  /** Skills 发现范围 + 清单预算配置（opt-in；缺省全扫全可调用）。 */
  skills?: SkillsConfig
  /** WebSearch 双源（bocha/tavily）配置；apiKey env 可覆盖（BOCHA_API_KEY/TAVILY_API_KEY）。 */
  webSearch?: WebSearchSettings
  /** hook URL 白名单（SSRF）：undefined=不限制；[]=全禁；非空=须匹配通配模式。 */
  allowedHttpHookUrls?: string[]
  /** http hook header env 插值的全局白名单；设了则与每个 hook 自身 allowedEnvVars 取交集。 */
  httpHookAllowedEnvVars?: string[]
  /** 记忆子系统配置（缺省全默认，见 memoryConfig.ts）。 */
  memory?: import('./memdir/memoryConfig.js').MemoryConfig
  /** 主题名（undefined = 运行期 Provider 兜底 dark；见 src/tui/theme.ts THEMES）。 */
  theme?: string
  /** 渲染器选择（undefined = 走决策链默认 fullscreen；见 src/tui/viewMode.ts resolveRenderer）。 */
  tui?: 'inline' | 'fullscreen'
  /** 启动初始视图（'focus' = 启动即开且锁定折叠视图；见 resolveInitialFocus）。 */
  viewMode?: 'default' | 'focus'
  /** 用户自设状态栏命令：执行取 stdout 附加进状态栏。仅信任 user scope（DANGEROUS_TOP_KEYS 剥离 project）。 */
  statusLineCommand?: string
  /** git worktree 配置（isolation:"worktree" / EnterWorktree 用；全层生效不剥离）。 */
  worktree?: { symlinkDirectories?: string[]; sparsePaths?: string[] }
  /** spinner tips 轮播开关（缺省 true）。纯 UX，非敏感，全层生效。 */
  spinnerTips?: boolean
  /** 自定义 spinner tips 覆盖。 */
  spinnerTipsOverride?: { tips?: string[]; excludeDefault?: boolean }
  /** 跳过 ultracode 关键字触发的多智能体消费警告（缺省 false）。 */
  skipWorkflowUsageWarning?: boolean
  /** 启用 ultracode 关键字自动触发 Workflow 工具引导（缺省 true）。 */
  workflowKeywordTriggerEnabled?: boolean
  /** /loop 自主模式结束判定：true=合并即视为任务完成（哨兵 preamble 用 persist 变体）。Task 14 加写入。 */
  doneMeansMerged?: boolean
  /** auto mode 分类器覆盖模型（缺省走 provider fast 档）。 */
  autoModeModel?: string
  /** auto mode 分类器是否启用 thinking（缺省 false）。 */
  autoModeThinking?: boolean
  /** 禁用 auto mode（缺省 false）。 */
  disableAutoMode?: boolean
  /** 桌面通知渠道。undefined = auto = 默认开。 */
  preferredNotifChannel?: NotifChannel
  /** 空闲多久（ms）无用户输入自动发桌面通知（默认 60000）。 */
  messageIdleNotifThresholdMs?: number
  /** git 署名文本覆盖。commit/pr 为空串=隐藏；缺省用 deepcode 内置文案。项目层剥离（防 prompt 注入）。 */
  attribution?: { commit?: string; pr?: string }
  /** 已弃用（用 attribution 代替）：false = commit trailer 与 PR body 署名都清空。 */
  includeCoAuthoredBy?: boolean
  /** 每技能可见性覆盖。缺省 on。/skills 交互编辑写 user 层。 */
  skillOverrides?: Record<string, SkillOverrideState>
}

/** 技能四态：on=完整；name-only=清单只名字；user-invocable-only=模型不可调用仅 /slash；off=两者皆禁。 */
export type SkillOverrideState = 'on' | 'name-only' | 'user-invocable-only' | 'off'

const SKILL_OVERRIDE_STATES = new Set<string>(['on', 'name-only', 'user-invocable-only', 'off'])

/** 解析 skillOverrides：只收 value ∈ 四态的键。非对象/空 → undefined。 */
export function parseSkillOverrides(raw: unknown): Record<string, SkillOverrideState> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, SkillOverrideState> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && SKILL_OVERRIDE_STATES.has(v)) out[k] = v as SkillOverrideState
  }
  return Object.keys(out).length ? out : undefined
}

/** 解析 attribution（只取 commit/pr 两个 string 字段，含空串）。无有效字段 → undefined。 */
export function parseAttribution(raw: unknown): { commit?: string; pr?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: { commit?: string; pr?: string } = {}
  if (typeof r.commit === 'string') out.commit = r.commit
  if (typeof r.pr === 'string') out.pr = r.pr
  return (out.commit !== undefined || out.pr !== undefined) ? out : undefined
}

const DIR = path.join(os.homedir(), '.deepcode')
const FILE = path.join(DIR, 'settings.json')

/** settings.json 绝对路径（ConfigChange 等 payload 的 file_path）。 */
export const SETTINGS_FILE = FILE

/** 后台任务输出落盘目录（~/.deepcode/tasks） */
export const TASKS_DIR = path.join(os.homedir(), '.deepcode', 'tasks')

/** todo 任务清单落盘根目录（~/.deepcode/task-lists/<sessionId>/<id>.json） */
export const TASK_LISTS_DIR = path.join(os.homedir(), '.deepcode', 'task-lists')

/** 后台任务输出日志路径 */
export function taskOutputPath(id: string): string {
  return path.join(TASKS_DIR, id + '.log')
}

const PERMISSION_MODES = new Set<string>(['default', 'acceptEdits', 'yolo', 'plan', 'auto', 'dontAsk'])

export function parsePermissions(raw: any): { allow: string[]; deny?: string[]; ask?: string[]; defaultMode?: PermissionMode } {
  const allow: string[] = Array.isArray(raw?.permissions?.allow)
    ? raw.permissions.allow.filter((s: unknown): s is string => typeof s === 'string')
    : []
  const out: { allow: string[]; deny?: string[]; ask?: string[]; defaultMode?: PermissionMode } = { allow }
  const rawDeny = raw?.permissions?.deny
  if (Array.isArray(rawDeny)) {
    const deny = rawDeny.filter((d: unknown): d is string => typeof d === 'string').map((d: string) => d.trim()).filter((d: string) => d.length > 0)
    if (deny.length) out.deny = deny
  }
  const rawAsk = raw?.permissions?.ask
  if (Array.isArray(rawAsk)) {
    const ask = rawAsk.filter((a: unknown): a is string => typeof a === 'string').map((a: string) => a.trim()).filter((a: string) => a.length > 0)
    if (ask.length) out.ask = ask
  }
  const rawMode = raw?.permissions?.defaultMode
  if (typeof rawMode === 'string' && PERMISSION_MODES.has(rawMode)) out.defaultMode = rawMode as PermissionMode
  return out
}

/** 单文件原始 user scope 解析（写路径用；= 旧 loadSettings 实现）。 */
export function loadRawUserSettings(): Settings {
  let raw: any = {}
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { /* 用默认 */ }
  return {
    permissions: parsePermissions(raw),
    compactTokens: raw?.compactTokens,
    precomputeCompactionEnabled: raw?.precomputeCompactionEnabled,
    costWarnCNY: raw?.costWarnCNY ?? raw?.costWarnUSD ?? 15,
    maxToolResultChars: raw?.maxToolResultChars ?? 100_000,
    model: raw?.model, baseURL: raw?.baseURL, apiKey: raw?.apiKey, inline: raw?.inline,
    tui: raw?.tui === 'inline' || raw?.tui === 'fullscreen' ? raw.tui : undefined,
    viewMode: raw?.viewMode === 'default' || raw?.viewMode === 'focus' ? raw.viewMode : undefined,
    hooks: parseHooksConfig(raw?.hooks), mcpServers: parseMcpServers(raw?.mcpServers),
    skills: parseSkillsConfig(raw?.skills), webSearch: parseWebSearchConfig(raw?.webSearch),
    allowedHttpHookUrls: parseStringArray(raw?.allowedHttpHookUrls),
    httpHookAllowedEnvVars: parseStringArray(raw?.httpHookAllowedEnvVars),
    memory: parseMemoryConfig(raw?.memory),
    provider: raw?.provider === 'glm' || raw?.provider === 'kimi' || raw?.provider === 'custom' || raw?.provider === 'deepseek' ? raw.provider : undefined,
    providers: parseProvidersConfig(raw?.providers),
    outputStyle: raw?.outputStyle,
    language: typeof raw?.language === 'string' && raw.language.trim() ? raw.language.trim() : undefined,
    cleanupPeriodDays: typeof raw?.cleanupPeriodDays === 'number' && raw.cleanupPeriodDays > 0 ? raw.cleanupPeriodDays : undefined,
    theme: raw?.theme,
    statusLineCommand: raw?.statusLineCommand,
    worktree: parseWorktreeConfig(raw?.worktree),
    spinnerTips: typeof raw?.spinnerTips === 'boolean' ? raw.spinnerTips : undefined,
    spinnerTipsOverride: parseSpinnerTipsOverride(raw?.spinnerTipsOverride),
    doneMeansMerged: typeof raw?.doneMeansMerged === 'boolean' ? raw.doneMeansMerged : undefined,
    autoModeModel: typeof raw?.autoModeModel === 'string' ? raw.autoModeModel : undefined,
    autoModeThinking: raw?.autoModeThinking === true ? true : undefined,
    disableAutoMode: raw?.disableAutoMode === true ? true : undefined,
    preferredNotifChannel: raw?.preferredNotifChannel === undefined ? undefined : resolveNotifChannel(raw?.preferredNotifChannel),
    messageIdleNotifThresholdMs: typeof raw?.messageIdleNotifThresholdMs === 'number' && raw.messageIdleNotifThresholdMs > 0 ? raw.messageIdleNotifThresholdMs : undefined,
  }
}

/** 运行时合并配置（分层）。所有只读消费者用此。 */
export function loadSettings(cwd?: string, flagPath?: string): Settings {
  return loadLayeredSettings(cwd, flagPath).settings
}

/** 宽松解析 settings.hooks：只留已知事件键、matcher 为对象数组、hooks 为对象数组的条目。非对象→undefined。 */
export function parseHooksConfig(raw: unknown): HooksConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: HooksConfig = {}
  const known = new Set<string>(HOOK_EVENTS)
  for (const [event, matchers] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(event) || !Array.isArray(matchers)) continue
    const valid = matchers.filter(
      (m): m is { matcher?: string; hooks: unknown[] } =>
        !!m && typeof m === 'object' && Array.isArray((m as any).hooks) &&
        (m as any).hooks.every((h: any) => h && typeof h === 'object' && typeof h.type === 'string'),
    )
    if (valid.length) (out as any)[event as HookEvent] = valid
  }
  return Object.keys(out).length ? out : undefined
}

/** 宽松解析 settings.mcpServers：只留 command 为非空字符串的条目；args 过滤非字符串；env 须为对象。 */
export function parseMcpServers(raw: unknown): Record<string, McpStdioServerConfig> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, McpStdioServerConfig> = {}
  for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue
    const c = cfg as Record<string, unknown>
    if (typeof c.command !== 'string' || !c.command) continue
    out[name] = {
      command: c.command,
      args: Array.isArray(c.args) ? (c.args.filter(a => typeof a === 'string') as string[]) : undefined,
      env: c.env && typeof c.env === 'object' && !Array.isArray(c.env) ? (c.env as Record<string, string>) : undefined,
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** 宽松解析 settings.skills：sources 仅留 'claude'|'deepcode'；deny 留 trim 后非空 string；
 *  listingBudgetChars 须正整数。任一字段非法即丢弃该字段（落默认）。非对象 → undefined。 */
export function parseSkillsConfig(raw: unknown): SkillsConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: SkillsConfig = {}
  if (Array.isArray(r.sources)) {
    const valid = r.sources.filter((s): s is 'claude' | 'deepcode' => s === 'claude' || s === 'deepcode')
    if (valid.length) out.sources = valid
  }
  if (Array.isArray(r.deny)) {
    const valid = r.deny.filter((d): d is string => typeof d === 'string').map(d => d.trim()).filter(d => d.length > 0)
    if (valid.length) out.deny = valid
  }
  if (typeof r.listingBudgetChars === 'number' && Number.isInteger(r.listingBudgetChars) && r.listingBudgetChars > 0) {
    out.listingBudgetChars = r.listingBudgetChars
  }
  return out
}

/** 宽松解析 settings.providers：deepseek/glm/kimi 取 {apiKey:string}；custom 须有 baseURL + models.fast/smart。
 *  custom.dialect 非 deepseek/glm/kimi/openai 则丢弃。非对象 → undefined。 */
export function parseProvidersConfig(raw: unknown): Settings['providers'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<Settings['providers']> = {}
  const keyOnly = (v: unknown): { apiKey?: string } | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const k = (v as Record<string, unknown>).apiKey
    return typeof k === 'string' && k ? { apiKey: k } : undefined
  }
  const ds = keyOnly(r.deepseek); if (ds) out.deepseek = ds
  const glm = keyOnly(r.glm); if (glm) out.glm = glm
  const kimi = keyOnly(r.kimi); if (kimi) out.kimi = kimi
  const c = r.custom
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const cc = c as Record<string, any>
    const models = cc.models
    if (typeof cc.baseURL === 'string' && cc.baseURL &&
        models && typeof models === 'object' &&
        typeof models.fast === 'string' && typeof models.smart === 'string') {
      const custom: CustomProvider = { baseURL: cc.baseURL, models: { fast: models.fast, smart: models.smart } }
      if (typeof cc.apiKeyEnv === 'string') custom.apiKeyEnv = cc.apiKeyEnv
      if (typeof cc.apiKey === 'string') custom.apiKey = cc.apiKey
      if (cc.dialect === 'deepseek' || cc.dialect === 'glm' || cc.dialect === 'kimi' || cc.dialect === 'openai') custom.dialect = cc.dialect
      if (cc.meta && typeof cc.meta === 'object') custom.meta = cc.meta as Record<string, ModelMeta>
      if (cc.defaultMeta && typeof cc.defaultMeta === 'object') custom.defaultMeta = cc.defaultMeta as ModelMeta
      out.custom = custom
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** 宽松解析 settings.webSearch：bocha/tavily 须为含非空 string apiKey 的对象才留；provider 留作向后兼容。非对象→undefined。 */
export function parseWebSearchConfig(raw: unknown): WebSearchSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: WebSearchSettings = {}
  const pick = (v: unknown): { apiKey: string } | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const k = (v as Record<string, unknown>).apiKey
    return typeof k === 'string' && k ? { apiKey: k } : undefined
  }
  const b = pick(r.bocha); if (b) out.bocha = b
  const t = pick(r.tavily); if (t) out.tavily = t
  if (typeof r.provider === 'string') out.provider = r.provider
  const a = r.anysearch
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const ar = a as Record<string, unknown>
    const enabled = typeof ar.enabled === 'boolean' ? ar.enabled : true // 缺省开；显式 false 保留
    const apiKey = typeof ar.apiKey === 'string' && ar.apiKey ? ar.apiKey : undefined
    out.anysearch = apiKey ? { enabled, apiKey } : { enabled }
  }
  return Object.keys(out).length ? out : undefined
}

/** 宽松解析 settings.worktree：symlinkDirectories/sparsePaths 各取 string[]。两者均无则返 undefined。 */
export function parseWorktreeConfig(raw: unknown): Settings['worktree'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<Settings['worktree']> = {}
  const sd = parseStringArray(r.symlinkDirectories); if (sd) out.symlinkDirectories = sd
  const sp = parseStringArray(r.sparsePaths); if (sp) out.sparsePaths = sp
  return (out.symlinkDirectories || out.sparsePaths) ? out : undefined
}

export function parseSpinnerTipsOverride(raw: unknown): { tips?: string[]; excludeDefault?: boolean } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: { tips?: string[]; excludeDefault?: boolean } = {}
  if (Array.isArray(r.tips)) {
    const tips = r.tips.filter((t): t is string => typeof t === 'string')
    if (tips.length) out.tips = tips
  }
  if (typeof r.excludeDefault === 'boolean') out.excludeDefault = r.excludeDefault
  return Object.keys(out).length ? out : undefined
}

/** 解析 string[]：过滤非 string、trim、去空。非数组 → undefined；空数组保留为 []（语义区分）。 */
export function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(s => s.length > 0)
}

/** 只写 user scope 原始文件（分层下唯一写目标，防洗白）。 */
export function saveRawUserSettings(s: Settings): void {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2))
  try { fs.chmodSync(FILE, 0o600) } catch { /* 尽力而为 */ }
}

export function hasApiKey(): boolean {
  return anyProviderKeyReady(loadSettings())
}

/** 首跑向导收集的 key 集合（per-provider，从不写遗留全局 apiKey）。 */
export type OnboardingKeys = {
  provider?: ProviderId
  model?: string
  providerKeys?: Partial<Record<'deepseek' | 'glm' | 'kimi' | 'custom', string>>
  custom?: { baseURL: string; models: { fast: string; smart: string } }
  search?: { bocha?: string; tavily?: string }
  visionGlmKey?: string
}

/** 向导写 key：RMW 覆盖 user 层，per-provider 字段深合并（不动兄弟 provider/webSearch 源，不写全局 apiKey）。
 *  空/未传字段跳过，不覆盖既有值。 */
export function saveOnboardingKeys(k: OnboardingKeys): void {
  const s = loadRawUserSettings()
  const hadKey = !!s.apiKey || Object.values(s.providers ?? {}).some(p => !!(p as { apiKey?: string } | undefined)?.apiKey)

  if (k.provider) s.provider = k.provider
  if (k.model) s.model = k.model

  const providers = (s.providers ?? {}) as Record<string, any>
  if (k.providerKeys) {
    for (const [id, key] of Object.entries(k.providerKeys)) {
      if (!key) continue
      providers[id] = { ...(providers[id] ?? {}), apiKey: key }
    }
  }
  if (k.custom) {
    providers.custom = { ...(providers.custom ?? {}), baseURL: k.custom.baseURL, models: k.custom.models }
  }
  if (k.visionGlmKey) {
    providers.glm = { ...(providers.glm ?? {}), apiKey: k.visionGlmKey }
  }
  if (Object.keys(providers).length) s.providers = providers as Settings['providers']

  if (k.search) {
    const webSearch = (s.webSearch ?? {}) as Record<string, any>
    if (k.search.bocha) webSearch.bocha = { ...(webSearch.bocha ?? {}), apiKey: k.search.bocha }
    if (k.search.tavily) webSearch.tavily = { ...(webSearch.tavily ?? {}), apiKey: k.search.tavily }
    if (Object.keys(webSearch).length) s.webSearch = webSearch as WebSearchSettings
  }

  saveRawUserSettings(s)
  if (s.hooks) void runHooks('Setup', { hook_event_name: 'Setup', cwd: process.cwd(), trigger: hadKey ? 'maintenance' : 'init' }, s.hooks).catch(() => {})
}

/** 往 user scope allow 列表加规则（raw RMW，不触其它 scope）。返回更新后的 user allow 数组。 */
export function addUserAllowRule(rule: string): string[] {
  const s = loadRawUserSettings()
  if (!s.permissions.allow.includes(rule)) s.permissions.allow.push(rule)
  saveRawUserSettings(s)
  return s.permissions.allow
}

/** 按 user scope allow 索引删除一条；返回被删规则或 undefined。 */
export function removeUserAllowRule(index: number): string | undefined {
  const s = loadRawUserSettings()
  if (s.permissions.allow[index] === undefined) return undefined
  const [removed] = s.permissions.allow.splice(index, 1)
  saveRawUserSettings(s)
  return removed
}

/** 读 user scope allow 列表（/permissions 显示用，保 rm 索引一致）。 */
export function listUserAllowRules(): string[] {
  return loadRawUserSettings().permissions.allow
}

/** 读 user scope deny 列表（/permissions 显示用）。 */
export function listUserDenyRules(): string[] {
  return loadRawUserSettings().permissions.deny ?? []
}

/** 按值从 user scope allow 删除（合并视图索引不对应 user 文件行，故按值）。删到返 true。 */
export function removeUserAllowRuleByValue(value: string): boolean {
  const s = loadRawUserSettings()
  const i = s.permissions.allow.indexOf(value)
  if (i < 0) return false
  s.permissions.allow.splice(i, 1)
  saveRawUserSettings(s)
  return true
}

/** 按值从 user scope deny 删除。删到返 true。 */
export function removeUserDenyRuleByValue(value: string): boolean {
  const s = loadRawUserSettings()
  const deny = s.permissions.deny
  if (!deny) return false
  const i = deny.indexOf(value)
  if (i < 0) return false
  deny.splice(i, 1)
  saveRawUserSettings(s)
  return true
}

/** 按值从 user scope ask 删除。删到返 true。 */
export function removeUserAskRuleByValue(value: string): boolean {
  const s = loadRawUserSettings()
  const ask = s.permissions.ask
  if (!ask) return false
  const i = ask.indexOf(value)
  if (i < 0) return false
  ask.splice(i, 1)
  saveRawUserSettings(s)
  return true
}
