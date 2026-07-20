import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  parsePermissions, parseHooksConfig, parseMcpServers, parseSkillsConfig,
  parseWebSearchConfig, parseStringArray, parseProvidersConfig, parseWorktreeConfig, parseSpinnerTipsOverride, parseAttribution, parseSkillOverrides, type Settings,
} from './config.js'
import { parseMemoryConfig } from './memdir/memoryConfig.js'
import { NOTIF_CHANNELS } from './notify.js'

export type SettingScope = 'user' | 'project' | 'local' | 'flag'

/** 整键剥离的危险字段（仅 project / git-tracked local）。 */
export const DANGEROUS_TOP_KEYS = [
  'apiKey', 'baseURL', 'hooks', 'mcpServers', 'webSearch',
  'allowedHttpHookUrls', 'httpHookAllowedEnvVars',
  'provider', 'providers', 'statusLineCommand',
  'autoModeModel', 'autoModeThinking', 'disableAutoMode',
  // language 注入系统提示（防恶意 repo prompt-injection）、cleanupPeriodDays 删会话文件（防恶意 repo 清历史）
  'language', 'cleanupPeriodDays',
  // attribution.commit/pr 拼进 /commit 喂模型的 guidance（项目层可写=prompt 注入通道）；
  // includeCoAuthoredBy:false 可静默去署名（防恶意 repo 抹掉 AI 归属，比常见做法更严格）
  'attribution', 'includeCoAuthoredBy',
  // skillOverrides 项目层可覆盖 user 层 off→重新启用用户禁用的技能（防恶意 repo 静默改会话；仅允许写 user/local 层）
  'skillOverrides',
] as const

/** 深拷 raw 后剥离危险字段；嵌套删 permissions.allow / skills.sources。返回剥掉的键名（含嵌套路径）。 */
export function stripUntrustedScope(raw: any): { raw: any; stripped: string[] } {
  const out = raw && typeof raw === 'object' ? structuredClone(raw) : raw
  const stripped: string[] = []
  if (!out || typeof out !== 'object') return { raw: out, stripped }
  for (const k of DANGEROUS_TOP_KEYS) {
    if (out[k] !== undefined) { delete out[k]; stripped.push(k) }
  }
  if (out.permissions && typeof out.permissions === 'object' && out.permissions.allow !== undefined) {
    delete out.permissions.allow; stripped.push('permissions.allow')
  }
  if (out.skills && typeof out.skills === 'object' && out.skills.sources !== undefined) {
    delete out.skills.sources; stripped.push('skills.sources')
  }
  if (out.permissions && typeof out.permissions === 'object' && out.permissions.defaultMode !== undefined) {
    delete out.permissions.defaultMode; stripped.push('permissions.defaultMode')
  }
  return { raw: out, stripped }
}

/** 文件是否被 git 跟踪（= repo 随身携带、非用户手写）。非 git 仓库 / git 不可用 → false。 */
export function isGitTracked(filePath: string, cwd: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', filePath], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface ScopePartial { scope: SettingScope; partial: Record<string, unknown> }

const DEFAULT_SETTINGS: Record<string, unknown> = {
  permissions: { allow: [] as string[] },
  costWarnCNY: 15,
  maxToolResultChars: 100_000,
}

function uniq<T>(arr: T[]): T[] { return [...new Set(arr)] }
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 深合并 src 进 target（就地）：数组 concat+去重、对象递归、标量覆盖。 */
function deepMergeInto(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    const cur = target[k]
    if (Array.isArray(cur) && Array.isArray(v)) target[k] = uniq([...cur, ...v])
    else if (isPlainObject(cur) && isPlainObject(v)) { const c = { ...cur }; deepMergeInto(c, v); target[k] = c }
    else target[k] = Array.isArray(v) ? [...v] : isPlainObject(v) ? { ...v } : v
  }
}

export function mergeScopePartials(layers: ScopePartial[]): {
  settings: any
  provenance: Record<string, SettingScope | 'merged'>
  permissionSources: { allow: Record<string, SettingScope>; deny: Record<string, SettingScope>; ask: Record<string, SettingScope> }
} {
  const settings: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS)
  const contributors: Record<string, Set<SettingScope>> = {}
  const isArrayOrObject: Record<string, boolean> = {}

  for (const { scope, partial } of layers) {
    for (const k of Object.keys(partial)) {
      if (partial[k] === undefined) continue
      const v = partial[k]
      ;(contributors[k] ??= new Set()).add(scope)
      isArrayOrObject[k] = Array.isArray(v) || isPlainObject(v)
    }
    deepMergeInto(settings, partial)
  }

  const provenance: Record<string, SettingScope | 'merged'> = {}
  for (const [k, set] of Object.entries(contributors)) {
    // 对于数组/对象：多 scope 贡献则 merged；对于标量：最后一个 scope 覆盖
    if (isArrayOrObject[k] && set.size > 1) {
      provenance[k] = 'merged'
    } else {
      // 找最后一个设置该 key 的 scope
      for (let i = layers.length - 1; i >= 0; i--) {
        if (layers[i].partial[k] !== undefined) {
          provenance[k] = layers[i].scope
          break
        }
      }
    }
  }

  const permissionSources: { allow: Record<string, SettingScope>; deny: Record<string, SettingScope>; ask: Record<string, SettingScope> } = { allow: {}, deny: {}, ask: {} }
  for (const { scope, partial } of layers) {
    const perm = partial.permissions as { allow?: string[]; deny?: string[]; ask?: string[] } | undefined
    if (perm?.allow) for (const r of perm.allow) permissionSources.allow[r] = scope
    if (perm?.deny) for (const r of perm.deny) permissionSources.deny[r] = scope
    if (perm?.ask) for (const r of perm.ask) permissionSources.ask[r] = scope
  }

  return { settings, provenance, permissionSources }
}

export interface LoadedScope {
  scope: SettingScope; path: string; present: boolean; demoted: boolean; stripped: string[]
}
export interface LayeredResult {
  settings: Settings
  provenance: Record<string, SettingScope | 'merged'>
  permissionSources: { allow: Record<string, SettingScope>; deny: Record<string, SettingScope>; ask: Record<string, SettingScope> }
  scopes: LoadedScope[]
  hookLayers: { scope: SettingScope; hooks: import('./hooks.js').HooksConfig }[]
}

/** 从各层 partial 收集配了 hooks 的层（保留 scope），供 /hooks 标注来源。按加载序。 */
export function deriveHookLayers(layers: ScopePartial[]): { scope: SettingScope; hooks: import('./hooks.js').HooksConfig }[] {
  return layers
    .filter(l => l.partial.hooks)
    .map(l => ({ scope: l.scope, hooks: l.partial.hooks as import('./hooks.js').HooksConfig }))
}

function scopePaths(cwd: string, flagPath?: string): { scope: SettingScope; path: string }[] {
  const out: { scope: SettingScope; path: string }[] = [
    { scope: 'user', path: path.join(os.homedir(), '.deepcode', 'settings.json') },
    { scope: 'project', path: path.join(cwd, '.deepcode', 'settings.json') },
    { scope: 'local', path: path.join(cwd, '.deepcode', 'settings.local.json') },
  ]
  if (flagPath) out.push({ scope: 'flag', path: flagPath })
  return out
}

/** 只对 raw 中实际存在的 key 跑对应 parser，产出 partial（不注入默认）。 */
function parsePresent(raw: any): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (!raw || typeof raw !== 'object') return p
  if ('permissions' in raw && raw.permissions && typeof raw.permissions === 'object') {
    const perm = parsePermissions(raw)
    const out: { allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: import('./permissions.js').PermissionMode } = {}
    if (Array.isArray(raw.permissions.allow)) out.allow = perm.allow
    if (perm.deny) out.deny = perm.deny
    if (perm.ask) out.ask = perm.ask
    if (perm.defaultMode) out.defaultMode = perm.defaultMode
    if (Object.keys(out).length) p.permissions = out
  }
  for (const k of ['compactTokens', 'costWarnCNY', 'maxToolResultChars', 'model', 'baseURL', 'apiKey', 'inline', 'provider'] as const) {
    if (raw[k] !== undefined) p[k] = raw[k]
  }
  if (typeof raw.precomputeCompactionEnabled === 'boolean') p.precomputeCompactionEnabled = raw.precomputeCompactionEnabled
  if (typeof raw.outputStyle === 'string') p.outputStyle = raw.outputStyle
  if (typeof raw.language === 'string' && raw.language.trim()) p.language = raw.language.trim()
  if (typeof raw.cleanupPeriodDays === 'number' && raw.cleanupPeriodDays > 0) p.cleanupPeriodDays = raw.cleanupPeriodDays
  if (typeof raw.theme === 'string') p.theme = raw.theme
  if (raw.tui === 'inline' || raw.tui === 'fullscreen') p.tui = raw.tui
  if (raw.viewMode === 'default' || raw.viewMode === 'focus') p.viewMode = raw.viewMode
  if (typeof raw.statusLineCommand === 'string') p.statusLineCommand = raw.statusLineCommand
  if ('hooks' in raw) { const h = parseHooksConfig(raw.hooks); if (h) p.hooks = h }
  if ('mcpServers' in raw) { const m = parseMcpServers(raw.mcpServers); if (m) p.mcpServers = m }
  if ('skills' in raw) { const s = parseSkillsConfig(raw.skills); if (s) p.skills = s }
  if ('webSearch' in raw) { const w = parseWebSearchConfig(raw.webSearch); if (w) p.webSearch = w }
  if ('allowedHttpHookUrls' in raw) { const a = parseStringArray(raw.allowedHttpHookUrls); if (a) p.allowedHttpHookUrls = a }
  if ('httpHookAllowedEnvVars' in raw) { const a = parseStringArray(raw.httpHookAllowedEnvVars); if (a) p.httpHookAllowedEnvVars = a }
  if ('memory' in raw) p.memory = parseMemoryConfig(raw.memory)
  if ('providers' in raw) { const pv = parseProvidersConfig(raw.providers); if (pv) p.providers = pv }
  if ('worktree' in raw) { const w = parseWorktreeConfig(raw.worktree); if (w) p.worktree = w }
  if (typeof raw.spinnerTips === 'boolean') p.spinnerTips = raw.spinnerTips
  if ('spinnerTipsOverride' in raw) { const o = parseSpinnerTipsOverride(raw.spinnerTipsOverride); if (o) p.spinnerTipsOverride = o }
  if (typeof raw.skipWorkflowUsageWarning === 'boolean') p.skipWorkflowUsageWarning = raw.skipWorkflowUsageWarning
  if (typeof raw.workflowKeywordTriggerEnabled === 'boolean') p.workflowKeywordTriggerEnabled = raw.workflowKeywordTriggerEnabled
  if (typeof raw.doneMeansMerged === 'boolean') p.doneMeansMerged = raw.doneMeansMerged
  if (typeof raw.autoModeModel === 'string') p.autoModeModel = raw.autoModeModel
  if (raw.autoModeThinking === true) p.autoModeThinking = true
  if (raw.disableAutoMode === true) p.disableAutoMode = true
  if (typeof raw.preferredNotifChannel === 'string' && (NOTIF_CHANNELS as string[]).includes(raw.preferredNotifChannel)) p.preferredNotifChannel = raw.preferredNotifChannel
  if (typeof raw.messageIdleNotifThresholdMs === 'number' && raw.messageIdleNotifThresholdMs > 0) p.messageIdleNotifThresholdMs = raw.messageIdleNotifThresholdMs
  if ('attribution' in raw) { const a = parseAttribution(raw.attribution); if (a) p.attribution = a }
  if (typeof raw.includeCoAuthoredBy === 'boolean') p.includeCoAuthoredBy = raw.includeCoAuthoredBy
  if ('skillOverrides' in raw) { const o = parseSkillOverrides(raw.skillOverrides); if (o) p.skillOverrides = o }
  return p
}

function readRaw(file: string): any | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

export function loadLayeredSettings(cwd: string = process.cwd(), flagPath?: string): LayeredResult {
  const layers: ScopePartial[] = []
  const scopes: LoadedScope[] = []
  for (const { scope, path: file } of scopePaths(cwd, flagPath)) {
    const raw = readRaw(file)
    const present = raw !== undefined
    let stripped: string[] = []
    let demoted = false
    let effective = raw
    if (present) {
      const untrusted = scope === 'project' || (scope === 'local' && isGitTracked(file, cwd))
      if (scope === 'local' && untrusted) demoted = true
      if (untrusted) { const r = stripUntrustedScope(raw); effective = r.raw; stripped = r.stripped }
      layers.push({ scope, partial: parsePresent(effective) })
    }
    scopes.push({ scope, path: file, present, demoted, stripped })
  }
  const { settings, provenance, permissionSources } = mergeScopePartials(layers)
  const hookLayers = deriveHookLayers(layers)
  return { settings: settings as Settings, provenance, permissionSources, scopes, hookLayers }
}
