// src/permissions.ts
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { parse, type ParseEntry } from 'shell-quote'
import type { Tool } from './tools/types.js'
import type { HookOutcome } from './hooks.js'
import { isDeniedPath } from './deny.js'
import { isInsideWorkspace } from './workspace.js'
import { matchHardDeny } from './autoMode.js'

const SEPARATORS = new Set(['&&', '||', ';', '|', '&'])
const REDIR = new Set(['>', '>>', '<', '>&', '<&'])

/**
 * 引号/转义感知扫描。对每个「裸」字符（不在引号内、自身未被反斜杠转义、
 * 且不是引号/转义控制符本身）调用 onBare(char, index)。
 * shell 语义：单引号内无转义；双引号内与无引号处反斜杠转义下一字符。
 */
function scanBareChars(s: string, onBare: (c: string, i: number) => void): void {
  let q: '' | '"' | "'" = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q === "'") { if (c === "'") q = ''; continue }   // 单引号内：仅 ' 结束，无转义
    if (q === '"') {                                       // 双引号内：\ 转义下一字符
      if (c === '\\') { i++; continue }
      if (c === '"') q = ''
      continue
    }
    if (c === '\\') { i++; continue }                     // 无引号：\ 转义下一字符
    if (c === '"' || c === "'") { q = c; continue }       // 进入引号
    onBare(c, i)
  }
}

/**
 * 引号感知地把未被引号包裹的 \n/\r 替换为 ';'，使 shell-quote 将其识别为命令分隔符。
 * 引号内的换行（如 echo "a\nb"）保留原样。
 */
function normalizeUnquotedNewlines(s: string): string {
  const chars = s.split('')
  scanBareChars(s, (c, i) => { if (c === '\n' || c === '\r') chars[i] = ';' })
  return chars.join('')
}

/** 用 shell-quote 把命令按控制操作符拆成子命令；含动态构造/分组或解析失败 → tooComplex（不得自动放行）。 */
/** 把命令按控制操作符拆成子命令的 token 数组（保留引号边界，不做 join）。
 *  含动态构造/分组或解析失败 → tooComplex（不得自动放行）。splitBashCommand 与 S4 检测共用此底座。 */
export function splitArgvGroups(command: string): { tooComplex: boolean; groups: string[][] } {
  // 动态构造无法静态证明安全：命令替换 $()/反引号、进程替换 <()/>()
  if (/\$\(|`|<\(|>\(/.test(command)) return { tooComplex: true, groups: [] }
  // 引号感知地把未引号换行归一成 ';'，防止换行绕过前缀匹配
  const normalized = normalizeUnquotedNewlines(command)
  let entries: ParseEntry[]
  try {
    entries = parse(normalized, (v: string) => '$' + v) // 保留 $VAR 字面量；传 {} 对象时 $VAR 被展开为空串（丢失参数 token）
  } catch {
    return { tooComplex: true, groups: [] }
  }
  const groups: string[][] = []
  let cur: string[] = []
  const flush = () => { if (cur.length) groups.push(cur); cur = [] }
  let skipTarget = false
  for (const e of entries) {
    if (skipTarget) { skipTarget = false; continue } // 跳过重定向目标
    if (typeof e === 'string') { cur.push(e); continue }
    const op = (e as { op: string }).op
    if (op === 'glob') { cur.push((e as { pattern: string }).pattern); continue }
    if (SEPARATORS.has(op)) { flush(); continue }
    if (REDIR.has(op)) { skipTarget = true; continue }
    return { tooComplex: true, groups: [] } // 未知 op（如 '('/')' 子shell分组）→ 保守拒绝
  }
  flush()
  return { tooComplex: false, groups }
}

/** 用 shell-quote 把命令按控制操作符拆成子命令（token 以空格 join）；含动态构造/分组或解析失败 → tooComplex。 */
export function splitBashCommand(command: string): { tooComplex: boolean; commands: string[] } {
  const { tooComplex, groups } = splitArgvGroups(command)
  return { tooComplex, commands: groups.map(g => g.join(' ')) }
}

export type PermissionMode = 'default' | 'acceptEdits' | 'yolo' | 'plan' | 'auto' | 'dontAsk'
export type Decision = 'yes' | 'no' | 'always'

export type PermissionRuleSource = 'builtin' | 'user' | 'project' | 'local' | 'flag'

export interface PermissionRule {
  source: PermissionRuleSource
  behavior: 'allow' | 'deny' | 'ask'
  value: string
}

export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'hook'; hookName: string; reason?: string }
  | { type: 'classifier'; decision: 'run' | 'ask' | 'block'; reasoning?: string }
  | { type: 'other'; reason: string }
  | { type: 'mode'; mode: PermissionMode }

const SOURCE_NAMES: Record<PermissionRuleSource, string> = {
  builtin: '内置规则',
  user: '用户设置',
  project: '共享项目设置',
  local: '项目本地设置',
  flag: '命令行参数',
}

/** 来源层级 → 中文显示名。 */
export function permissionSourceName(s: PermissionRuleSource): string {
  return SOURCE_NAMES[s] ?? String(s)
}

/** 生成「总是允许」将保存的规则（预览与保存共用，单一来源）。deepcode 既有粒度：Bash 普通=前 2 词+:*，高危/复合=精确，非 Bash=精确。 */
export function suggestRule(toolName: string, desc: string): string {
  const firstLine = desc.split('\n')[0]
  const compound = toolName === 'Bash' && splitBashCommand(desc).commands.length > 1
  const pat = toolName === 'Bash'
    ? (isDangerous(desc) || compound)
      ? desc.replace(/\n/g, ' ')
      : firstLine.split(' ').slice(0, 2).join(' ') + ':*'
    : desc.replace(/\n/g, ' ')
  return `${toolName}(${pat})`
}

export interface PermissionContext {
  mode: PermissionMode
  rules: string[]
  saveRule: (rule: string) => void
  ask: (toolName: string, desc: string, reason?: PermissionDecisionReason, previewRule?: string) => Promise<Decision>
  deny?: string[]
  cwd?: string
  ruleSources?: Record<string, PermissionRuleSource>
  denySources?: Record<string, PermissionRuleSource>
  /** ask 规则桶：Tool(pattern) 走 desc 匹配（非只读），裸 glob 走路径匹配（含只读）。命中强制弹窗。 */
  askRules?: string[]
  askSources?: Record<string, PermissionRuleSource>
  /** 工作目录围栏白名单（/add-dir 注入，会话内）。cwd 与这些目录之外的路径触发 ask。 */
  additionalDirs?: string[]
  classify?: (toolName: string, desc: string, sibling: string) => Promise<'run' | 'ask' | 'block'>
  recentContext?: () => string
  /** S1 auto 模式拒绝熔断器计数（会话级可变态；由 checkPermission 增减）。 */
  autoDenials?: { consecutive: number; total: number }
  /** B7：workflow 用量确认「总是」时持久化 skipWorkflowUsageWarning:true。 */
  setSkipWorkflowWarning?: () => void
}

// S1：auto 模式拒绝熔断器阈值（硬编码不可配）。
// 连续 block ≥3 或整会话 block ≥20 → 不再自动拦，回退问用户（防分类器反复 block 卡死循环）。
export const AUTO_MODE_MAX_CONSECUTIVE_DENIALS = 3
export const AUTO_MODE_MAX_TOTAL_DENIALS = 20

export interface PermissionHooks {
  /** 交互 ask 前：hook 可返回 permission==='allow'（跳弹窗放行）或 'deny'/block（拒绝）。 */
  onRequest?: (toolName: string, desc: string) => Promise<HookOutcome>
  /** 判定拒绝后：记录/通知。 */
  onDenied?: (toolName: string, desc: string, reason: string) => Promise<void>
}

const DANGEROUS_PATTERNS = [
  /\brm\s+(-\w+\s+)*-\w*r\w*f/i, // rm -rf 及参数变体
  /\brm\s+(-\w+\s+)*-\w*f\w*r/i, // rm -fr
  /\bsudo\b/,
  /--force(?!-)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,
]

/** 高危命令：权限弹窗加警告，always 不做前缀放宽只存精确规则 */
export function isDangerous(desc: string): boolean {
  return DANGEROUS_PATTERNS.some(re => re.test(desc))
}

// ─── S4：保护系统路径 ──────────────────────────────
// rm/rmdir 打到「关键路径」必须强制问人：绕过 allow 规则、分类器、yolo，任何模式都不能自动放行。
// 这是确定性安全兜底，不依赖 LLM 判断。

const casefold = (x: string): string => x.toLowerCase()
const stripTrailingSlash = (p: string): string => (p === '/' ? p : p.replace(/\/+$/, ''))

/** 目标路径是否为受保护的关键系统路径（结构规则，非硬编码清单）：
 *  文件系统根 `/`、家目录（含 realpath）、根下任意一级目录（/etc /usr /bin /var …）、整树通配 `*`、`/*`。
 *  target 须为已解析的绝对路径（`*`/`/*` 通配除外）。macOS 折叠 /private/{etc,var,tmp,home}。 */
export function isProtectedSystemPath(
  target: string,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const t = target.replace(/[\\/]+/g, '/')
  if (t === '*' || t.endsWith('/*')) return true // 整树通配目标
  const fold = (c: string): string =>
    platform === 'darwin' ? c.replace(/^\/private\/(etc|var|tmp|home)(\/|$)/i, '/$1$2') : c
  const s = stripTrailingSlash(fold(t))
  if (s === '/') return true // 文件系统根
  const h = stripTrailingSlash(fold(home.replace(/[\\/]+/g, '/')))
  if (casefold(s) === casefold(h)) return true // 家目录
  try {
    const rp = stripTrailingSlash(fs.realpathSync(home).replace(/[\\/]+/g, '/'))
    if (rp !== h && casefold(s) === casefold(rp)) return true // 家目录 realpath（symlink 情形）
  } catch { /* realpath 失败忽略 */ }
  if (path.posix.dirname(s) === '/') return true // 根下任意一级目录 /etc /usr /bin /var …
  return false
}

/** 把 rm 目标解析成绝对路径；~ 展开、相对路径按 cwd 解析。无法确定则返回 null。 */
function resolveRemovalTarget(raw: string, cwd: string, home: string): string | null {
  let p = raw
  const h = home.replace(/[\\/]+/g, '/')
  if (p === '~') p = h
  else if (p.startsWith('~/')) p = path.posix.join(h, p.slice(2))
  p = p.replace(/[\\/]+/g, '/')
  if (p.startsWith('/')) return path.posix.normalize(p)
  return path.posix.normalize(path.posix.join(cwd.replace(/[\\/]+/g, '/'), p))
}

/** abs 是否等于 cwd 或为 cwd 的祖先目录（删它会连带删掉工作目录）。 */
function isAncestorOrSelf(abs: string, cwd: string): boolean {
  const a = stripTrailingSlash(abs)
  const c = stripTrailingSlash(cwd.replace(/[\\/]+/g, '/'))
  return a === c || c.startsWith(a + '/')
}

/** 剥掉 token 头部的分组符（(){}）便于取真实命令名，如 `(rm`→`rm`、`{rm`→`rm`。 */
const stripGrouping = (t: string): string => t.replace(/^[(){}]+/, '')
/** token 的命令名（去分组符 + basename）是否为 rm/rmdir。 */
function removalWord(tok: string): boolean {
  const b = path.posix.basename(stripGrouping(tok).replace(/[\\/]+/g, '/'))
  return b === 'rm' || b === 'rmdir'
}

/** 检测 Bash 命令里是否有打到关键路径/工作目录的 rm/rmdir。命中→返回 {target,reason}，否则 null。
 *  规则：整树通配、关键系统路径、工作目录及其父目录、cd 后无法静态解析的相对目标 都要问人。
 *  加固（opus 终审揪出的绕过）：①在每条子命令里「扫描 rm/rmdir token」而非只看 argv[0]——这样
 *  wrapper（sudo/env/xargs/nice/timeout…）与分组（{ }/( )）里的 rm 都能抓到；②目标含 $/反引号
 *  （变量/命令替换）→ 判无法静态解析强制问人；③无法静态拆分的复杂命令若含 rm/rmdir → 保守问人。 */
export function detectDangerousRemoval(
  command: string,
  cwd: string,
  home: string = os.homedir(),
): { target: string; reason: string } | null {
  const { tooComplex, groups } = splitArgvGroups(command)
  if (tooComplex) {
    // $()/反引号/子shell/未知分组 → 无法静态解析；含 rm/rmdir 就保守问人（防命令替换绕过）。
    // 用词边界 \b：/ 与反引号天然是边界（覆盖 `rm…`、$(/bin/rm…) 等路径/反引号相邻形），
    // 又不误伤 warm/alarm/firmware/$(git status)（终审验证）。
    if (/\b(rm|rmdir)\b/.test(command)) {
      const t = command.length > 60 ? command.slice(0, 60) + '…' : command
      return { target: t, reason: '无法静态解析的复杂命令中含删除操作' }
    }
    return null
  }
  let sawCd = false
  for (const argv of groups) {
    const idx = argv.findIndex(removalWord)
    if (idx < 0) {
      // 记录 cd（首个真实 token 是 cd）→ 后续相对目标无法静态解析
      const first = path.posix.basename(stripGrouping(argv[0] ?? '').replace(/[\\/]+/g, '/'))
      if (first === 'cd') sawCd = true
      continue
    }
    for (const raw of argv.slice(idx + 1)) {
      if (raw.startsWith('-')) continue // 跳过 flag
      if (raw.includes('$') || raw.includes('`')) return { target: raw, reason: `含变量/命令替换、无法静态解析的目标：${raw}` }
      if (raw === '*' || raw.endsWith('/*')) return { target: raw, reason: `整树通配目标：${raw}` }
      const isAbs = raw.startsWith('/') || raw === '~' || raw.startsWith('~/')
      if (!isAbs && sawCd) return { target: raw, reason: `cd 后无法静态解析的目标：${raw}` }
      const abs = resolveRemovalTarget(raw, cwd, home)
      if (abs === null) return { target: raw, reason: `无法静态解析的目标：${raw}` }
      if (isProtectedSystemPath(abs, home)) return { target: raw, reason: `关键系统路径：${raw}` }
      if (isAncestorOrSelf(abs, cwd)) return { target: raw, reason: `工作目录或其父目录：${raw}` }
    }
  }
  return null
}

/** 检测未被引号包裹的 shell 控制操作符。 */
export function hasUnquotedOperator(s: string): boolean {
  let found = false
  scanBareChars(s, c => { if (c === ';' || c === '&' || c === '|') found = true })
  return found
}

/** 规则形如 Bash(npm test:*)（前缀）或 Bash(ls)（精确） */
export function matchRule(rule: string, toolName: string, desc: string): boolean {
  const m = rule.match(/^(\w+)\((.+)\)$/)
  if (!m) return false
  const [, name, pat] = m
  if (name !== toolName) return false
  const normDesc = desc.replace(/\n/g, ' ') // 规则存储侧同样做了 \n→空格 归一化
  if (pat.endsWith(':*')) {
    // backstop：Bash 复合命令绝不走前缀匹配
    if (toolName === 'Bash' && hasUnquotedOperator(normDesc)) return false
    const prefix = pat.slice(0, -2)
    return normDesc === prefix || normDesc.startsWith(prefix + ' ')
  }
  return normDesc === pat
}

/** 仅用精确规则（非前缀）匹配，供复合命令全量检查使用，防止前缀规则跨段匹配。 */
function matchExactRule(rule: string, toolName: string, desc: string): boolean {
  const m = rule.match(/^(\w+)\((.+)\)$/)
  if (!m) return false
  const [, name, pat] = m
  if (name !== toolName) return false
  if (pat.endsWith(':*')) return false // 复合命令全量检查不走前缀规则
  return desc.replace(/\n/g, ' ') === pat
}

/** 返回第一条命中规则字符串，无则 null。 */
export function findMatchingRule(rules: string[], toolName: string, desc: string): string | null {
  for (const r of rules) if (matchRule(r, toolName, desc)) return r
  return null
}

/** Bash 命中规则查找：too-complex→null；单命令→现匹配；复合→精确全量规则 OR 每段覆盖（返回首段命中规则作代表）。 */
export function findBashMatchingRule(command: string, rules: string[]): string | null {
  const { tooComplex, commands } = splitBashCommand(command)
  if (tooComplex) return null
  if (commands.length <= 1) {
    const d = commands[0] ?? command
    return findMatchingRule(rules, 'Bash', d)
  }
  for (const r of rules) if (matchExactRule(r, 'Bash', command)) return r
  if (commands.every(s => rules.some(r => matchRule(r, 'Bash', s)))) {
    return findMatchingRule(rules, 'Bash', commands[0])
  }
  return null
}

/** Bash 命令是否被规则集允许（委托 findBashMatchingRule，保持原行为）。 */
export function bashCommandAllowed(command: string, rules: string[]): boolean {
  return findBashMatchingRule(command, rules) !== null
}

/** dontAsk 模式哨兵：prompt() 在 dontAsk 下抛出，由 checkPermission 单点捕获转 mode-deny。 */
class DontAskDeny extends Error {
  constructor(public readonly toolName: string) { super('dontAsk'); this.name = 'DontAskDeny' }
}

export async function checkPermission(
  tool: Tool<any>,
  input: unknown,
  pc: PermissionContext,
  hooks?: PermissionHooks,
): Promise<
  | { ok: true; decisionReason?: PermissionDecisionReason }
  | { ok: false; reason: string; decisionReason?: PermissionDecisionReason }
> {
  const prompt = (toolName: string, d: string, reason?: PermissionDecisionReason, previewRule?: string): Promise<Decision> => {
    if (pc.mode === 'dontAsk') throw new DontAskDeny(toolName)
    return pc.ask(toolName, d, reason, previewRule)
  }
  // deny 最高优先级：早于 isReadOnly/yolo/acceptEdits/rules
  let forceAsk = false
  let denyHit: string | null = null
  if (pc.deny?.length && tool.deniablePaths) {
    for (const p of tool.deniablePaths(input as any, pc.cwd ?? process.cwd())) {
      const hit = isDeniedPath(p, pc.deny)
      if (!hit) continue
      denyHit = hit
      if (tool.name === 'Bash') { forceAsk = true; break } // Bash：降级 ask 防误操作
      const src = pc.denySources?.[hit] ?? 'builtin'
      const reason = `路径被 deny 规则拒绝（${hit}，来自 ${permissionSourceName(src)}）`
      await hooks?.onDenied?.(tool.name, tool.needsPermission(input) || tool.name, reason)
      return { ok: false, reason, decisionReason: { type: 'rule', rule: { source: src, behavior: 'deny', value: hit } } }
    }
  }
  try {
    // [新] plan 门：plan 模式非只读一律拒（不带 !forceAsk——严于 deny 降级 ask；deny 已在上方优先处理）
    if (pc.mode === 'plan' && !tool.isReadOnly) {
      const reason = 'plan 模式为只读，需先退出 plan 模式（ExitPlanMode）'
      await hooks?.onDenied?.(tool.name, tool.needsPermission(input) || tool.name, reason)
      return { ok: false, reason, decisionReason: { type: 'other', reason: 'plan 模式只读' } }
    }
    // [S4] 保护系统路径守卫：Bash rm/rmdir 打到关键路径 → 强制问人。
    // 绕过 allow 规则/分类器/yolo，任何模式（除 plan 上方已拒）都不能自动放行。
    // 放在 yolo 早返之前——这是确定性安全兜底，连 yolo 也拦。
    if (tool.name === 'Bash' && typeof tool.needsPermission === 'function') {
      const cmd = tool.needsPermission(input)
      if (typeof cmd === 'string') {
        const danger = detectDangerousRemoval(cmd, pc.cwd ?? process.cwd(), os.homedir())
        if (danger) {
          const warnDesc = `危险删除操作：'${danger.target}'——目标是关键系统目录或工作目录，会造成不可逆破坏。此操作需显式确认，不能被权限规则或分类器自动放行。`
          const reason: PermissionDecisionReason = { type: 'other', reason: `保护路径守卫（${danger.reason}）` }
          const d = await prompt(tool.name, warnDesc, reason)
          if (d === 'no') {
            await hooks?.onDenied?.(tool.name, cmd, `保护路径守卫：用户拒绝删除 ${danger.target}`)
            return { ok: false, reason: `保护路径守卫：用户拒绝删除 ${danger.target}`, decisionReason: reason }
          }
          return { ok: true, decisionReason: reason } // yes/always：放行本次，不存规则（不可自动放行）
        }
      }
    }
    // [新] 工作目录围栏：tool 工作路径在 cwd∪白名单外 → 问用户。
    // 必须在 isReadOnly 早返(下一行)之前——否则 Read/Glob/Grep 被 :219 desc===false 短路放行，围栏失效。
    // yolo 旁路；deny 已在最上方优先处理（围栏不凌驾 deny）。
    if (pc.mode !== 'yolo' && tool.workspacePaths) {
      const roots = [pc.cwd ?? process.cwd(), ...(pc.additionalDirs ?? [])]
      const outside = tool.workspacePaths(input as any, pc.cwd ?? process.cwd()).find(p => !isInsideWorkspace(p, roots))
      if (outside) {
        const fenceDesc = tool.needsPermission(input) || `访问工作目录外的路径：${outside}`
        const d = await prompt(tool.name, fenceDesc)
        if (d === 'no') {
          await hooks?.onDenied?.(tool.name, fenceDesc, '路径在工作目录外，用户拒绝')
          return { ok: false, reason: '路径在工作目录外，用户拒绝', decisionReason: { type: 'other', reason: '工作目录围栏' } }
        }
        return { ok: true } // yes/always：放行本次（围栏是路径维度，不写规则）
      }
    }
    // [B7] Workflow 用量同意门：Workflow 是 isReadOnly:true 会被下方短路自动放行。
    // 若未跳过警告（needsPermission 返串）→ 确认：
    // yes 放行本次 / always 持久化 skipWorkflowUsageWarning / no 拒绝。
    if (tool.name === 'Workflow' && typeof tool.needsPermission === 'function') {
      const warn = tool.needsPermission(input)
      if (typeof warn === 'string') {
        const reason: PermissionDecisionReason = { type: 'other', reason: 'workflow 用量确认' }
        const d = await prompt(tool.name, warn, reason)
        if (d === 'no') {
          await hooks?.onDenied?.(tool.name, warn, '用户取消了 workflow 运行')
          return { ok: false, reason: '用户取消了 workflow 运行', decisionReason: reason }
        }
        if (d === 'always') pc.setSkipWorkflowWarning?.()
        return { ok: true, decisionReason: reason }
      }
    }
    // [ask 桶·路径维度] 裸 glob ask 规则命中 tool 路径 → 强制弹窗（凌驾 allow/yolo/只读短路）。
    // 仿工作目录围栏，但不 yolo 旁路（ask 凌驾 yolo）；deny 已在最上方优先。
    const askGlobRules = (pc.askRules ?? []).filter(r => !/^\w+\(.+\)$/.test(r))
    if (askGlobRules.length && tool.deniablePaths) {
      for (const p of tool.deniablePaths(input as any, pc.cwd ?? process.cwd())) {
        const hit = isDeniedPath(p, askGlobRules)
        if (!hit) continue
        const askDesc = tool.needsPermission(input) || `访问受 ask 规则保护的路径：${p}`
        const reason: PermissionDecisionReason = { type: 'rule', rule: { source: pc.askSources?.[hit] ?? 'user', behavior: 'ask', value: hit } }
        const d = await prompt(tool.name, askDesc as string, reason)
        if (d === 'no') {
          await hooks?.onDenied?.(tool.name, String(askDesc), `ask 规则拒绝：${hit}`)
          return { ok: false, reason: `ask 规则：用户拒绝（${hit}）`, decisionReason: reason }
        }
        return { ok: true, decisionReason: reason } // 路径维度不写规则
      }
    }
    if (tool.isReadOnly && !forceAsk) return { ok: true }
    const desc = tool.needsPermission(input)
    if (desc === false && !forceAsk) return { ok: true }
    if (desc === false) return { ok: true } // forceAsk 仅对 Bash（desc 恒为 string）
    // [ask 桶·命令/描述维度] Tool(pattern) ask 规则命中 desc → 强制弹窗（凌驾 allow/yolo）。
    const askToolRules = (pc.askRules ?? []).filter(r => /^\w+\(.+\)$/.test(r))
    const askMatched = tool.name === 'Bash'
      ? findBashMatchingRule(desc, askToolRules)
      : findMatchingRule(askToolRules, tool.name, desc)
    if (askMatched) {
      const reason: PermissionDecisionReason = { type: 'rule', rule: { source: pc.askSources?.[askMatched] ?? 'user', behavior: 'ask', value: askMatched } }
      const preview = suggestRule(tool.name, desc)
      const d = await prompt(tool.name, desc, reason, preview)
      if (d === 'always') { pc.saveRule(preview); return { ok: true, decisionReason: reason } }
      if (d === 'yes') return { ok: true, decisionReason: reason }
      await hooks?.onDenied?.(tool.name, desc, `ask 规则拒绝：${askMatched}`)
      return { ok: false, reason: '用户拒绝了此操作', decisionReason: reason }
    }
    if (pc.mode === 'yolo' && !forceAsk) return { ok: true }
    if (pc.mode === 'acceptEdits' && !forceAsk && (tool.name === 'Edit' || tool.name === 'Write')) return { ok: true }
    const matched = tool.name === 'Bash'
      ? findBashMatchingRule(desc, pc.rules)
      : findMatchingRule(pc.rules, tool.name, desc)
    if (matched && !forceAsk) {
      const src = pc.ruleSources?.[matched] ?? 'user'
      return { ok: true, decisionReason: { type: 'rule', rule: { source: src, behavior: 'allow', value: matched } } }
    }
    // auto 模式：无 allow 命中 → 静态 hard_deny 兜底 → 分类器兜底（规则先于分类器）
    if (pc.mode === 'auto' && !forceAsk && pc.classify) {
      // acceptEdits fast-path：Edit/Write 在 acceptEdits 下本就放行 → 跳过分类器（省每次 ~3s 延迟）。
      // 安全性：越界写已被上方工作目录围栏拦；in-workspace 编辑走 acceptEdits 语义（可逆可 review）。
      if (tool.name === 'Edit' || tool.name === 'Write') return { ok: true }
      if (matchHardDeny(tool.name, desc)) {
        const reason = 'auto mode：命中安全边界硬规则（不可逆/外泄/后门），已拦截'
        await hooks?.onDenied?.(tool.name, desc, reason)
        return { ok: false, reason, decisionReason: { type: 'classifier', decision: 'block' } }
      }
      const sibling = pc.recentContext?.() ?? ''
      const decision = await pc.classify(tool.name, desc, sibling)
      if (decision === 'run') {
        if (pc.autoDenials) pc.autoDenials.consecutive = 0 // 放行→连续计数归零（total 累积整会话）
        return { ok: true, decisionReason: { type: 'classifier', decision: 'run' } }
      }
      if (decision === 'block') {
        // S1 熔断器：连续 block ≥3 或整会话 block ≥20 → 不再自动拦，回退问用户，
        // 防分类器反复 block 卡死循环。total 触发时清零两计数给复查后的新窗口。hard_deny 不走此路（永硬拦）。
        const t = pc.autoDenials
        let tripped = false
        if (t) {
          t.consecutive += 1; t.total += 1
          tripped = t.consecutive >= AUTO_MODE_MAX_CONSECUTIVE_DENIALS || t.total >= AUTO_MODE_MAX_TOTAL_DENIALS
          if (tripped && t.total >= AUTO_MODE_MAX_TOTAL_DENIALS) { t.total = 0; t.consecutive = 0 }
        }
        if (!tripped) {
          const reason = 'auto mode 分类器判定为高风险，已拦截'
          await hooks?.onDenied?.(tool.name, desc, reason)
          return { ok: false, reason, decisionReason: { type: 'classifier', decision: 'block' } }
        }
        // 熔断跳闸：fall through 到下方 pc.ask，把决定权交回用户
      }
      // 'ask'（或熔断跳闸）→ 继续 fall through 到下方现有 pc.ask（用户确认）
    }
    // PermissionRequest hook：交互 ask 前。allow→放行；deny/block→拒绝。
    if (hooks?.onRequest) {
      const out = await hooks.onRequest(tool.name, desc)
      if (out.permission === 'allow') return { ok: true }
      if (out.permission === 'deny' || out.block) {
        const reason = out.permissionReason ?? out.blockReason ?? '权限被 hook 拒绝'
        await hooks.onDenied?.(tool.name, desc, reason)
        return { ok: false, reason, decisionReason: { type: 'hook', hookName: 'PermissionRequest', reason } }
      }
      // fall through 到 pc.ask（fail-safe 问用户）。
    }
    const askReason: PermissionDecisionReason | undefined = denyHit
      ? { type: 'rule', rule: { source: pc.denySources?.[denyHit] ?? 'builtin', behavior: 'deny', value: denyHit } }
      : undefined
    const previewRule = suggestRule(tool.name, desc)
    const decision = await prompt(tool.name, desc, askReason, previewRule)
    if (decision === 'always') {
      pc.saveRule(previewRule)
      return { ok: true }
    }
    if (decision === 'yes') return { ok: true }
    await hooks?.onDenied?.(tool.name, desc, '用户拒绝了此操作')
    return { ok: false, reason: '用户拒绝了此操作', decisionReason: { type: 'other', reason: '用户拒绝了此操作' } }
  } catch (e) {
    if (e instanceof DontAskDeny) {
      const reason = `dontAsk 模式：${e.toolName} 未被预先批准，已自动拒绝（不弹窗）。Shift+Tab 可切换权限模式。`
      await hooks?.onDenied?.(e.toolName, e.toolName, reason)
      return { ok: false, reason, decisionReason: { type: 'mode', mode: 'dontAsk' } }
    }
    throw e
  }
}
