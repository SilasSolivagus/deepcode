// src/tui/suggest.ts
import fs from 'node:fs'
import path from 'node:path'
import stringWidth from 'string-width'

export interface Suggestion { value: string; hint: string }

const graphemeSeg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function graphemes(s: string): string[] {
  return [...graphemeSeg.segment(s)].map(g => g.segment)
}

/** 折叠空白后取第一句（到句末标点 。.!！?？ 止），用于菜单简写长技能描述——源描述不动（模型仍用完整版）。 */
export function firstSentence(s: string): string {
  const folded = s.replace(/\s+/g, ' ').trim()
  const m = folded.match(/^[^。.!！?？]*[。.!！?？]/)
  return (m ? m[0] : folded).trim()
}

/** 按终端显示宽度（CJK/emoji 计 2 列）截断到 maxCols，按字形簇切，末尾加单个省略号 …（预留 1 列）。 */
export function truncateToWidth(s: string, maxCols: number): string {
  if (maxCols <= 0) return ''
  if (stringWidth(s) <= maxCols) return s
  if (maxCols <= 1) return '…'
  let out = '', w = 0
  for (const g of graphemes(s)) {
    const gw = stringWidth(g)
    if (w + gw > maxCols - 1) break
    out += g; w += gw
  }
  return out + '…'
}

/** 描述布局（最多 2 行）：放得下 avail1→[desc,'']；否则第 1 行按词边界拆、第 2 行截断到 avail2。 */
export function layoutDescription(desc: string, avail1: number, avail2: number): { line1: string; line2: string } {
  const s = desc.replace(/\s+/g, ' ').trim()
  if (avail1 <= 0 || s === '') return { line1: '', line2: '' }
  if (stringWidth(s) <= avail1) return { line1: s, line2: '' }
  // 硬截到 avail1（字形簇）
  let hard = '', w = 0
  for (const g of graphemes(s)) {
    const gw = stringWidth(g)
    if (w + gw > avail1) break
    hard += g; w += gw
  }
  // 回退到最后一个空格做词边界拆分；无空格（如中文长句）则硬截
  const lastSpace = hard.lastIndexOf(' ')
  const line1 = lastSpace > 0 ? hard.slice(0, lastSpace) : hard
  const rest = (lastSpace > 0 ? s.slice(lastSpace + 1) : s.slice(hard.length)).trim()
  return { line1, line2: truncateToWidth(rest, avail2) }
}

/** 行预算开窗：以 selected 为中心，按每项行高 heights[] 累加不超过 lineBudget，返回 [start,end)。保证输入框不被挤出屏。 */
export function computeLineWindow(heights: number[], selected: number, lineBudget: number): { start: number; end: number } {
  const n = heights.length
  if (n === 0) return { start: 0, end: 0 }
  const sel = Math.max(0, Math.min(selected, n - 1))
  let start = sel, end = sel + 1, used = heights[sel]
  for (;;) {
    let grew = false
    if (end < n && used + heights[end] <= lineBudget) { used += heights[end]; end++; grew = true }
    if (start > 0 && used + heights[start - 1] <= lineBudget) { used += heights[start - 1]; start--; grew = true }
    if (!grew) break
  }
  return { start, end }
}

export const BUILTIN_COMMANDS: Suggestion[] = [
  { value: '/model', hint: 'flash↔pro 切换（/model <名> 指定）' },
  { value: '/setup', hint: '重新配置 API key（LLM/搜索/图片识别）' },
  { value: '/think', hint: 'thinking 模式开关' },
  { value: '/accept', hint: 'acceptEdits 开关' },
  { value: '/cost', hint: '本会话花费明细' },
  { value: '/recap', hint: '一句话回顾当前会话' },
  { value: '/goal', hint: '设置/查看/清除会话级停止目标' },
  { value: '/context', hint: '上下文占比' },
  { value: '/stats', hint: '本会话统计' },
  { value: '/copy', hint: '复制回复到剪贴板（/copy N 倒数第N条 · /copy code 最后代码块）' },
  { value: '/memory', hint: '查看生效的记忆文件' },
  { value: '/compact', hint: '手动压缩历史' },
  { value: '/clear', hint: '清空对话' },
  { value: '/resume', hint: '恢复历史会话' },
  { value: '/fork', hint: '分叉当前会话继续' },
  { value: '/rename', hint: '给当前会话命名' },
  { value: '/export', hint: '导出对话到 markdown' },
  { value: '/diff', hint: '查看未提交的 git 改动' },
  { value: '/status', hint: '会话状态一览（版本/模型/模式/工具数）' },
  { value: '/doctor', hint: '诊断安装/配置/连通性' },
  { value: '/skills', hint: '列出可用技能' },
  { value: '/mcp', hint: '查看已配置的 MCP server' },
  { value: '/hooks', hint: '查看已配置的 hook' },
  { value: '/config', hint: '查看合并配置与来源追溯' },
  { value: '/permissions', hint: '权限规则管理' },
  { value: '/workflows', hint: '查看 workflow 运行历史' },
  { value: '/init', hint: '生成 DEEPCODE.md' },
  { value: '/keybindings', hint: '查看快捷键' },
  { value: '/tui', hint: '切换渲染器（inline/fullscreen）' },
  { value: '/focus', hint: '切换 focus 视图（全屏折叠工具）' },
  { value: '/help', hint: '帮助' },
  { value: '/exit', hint: '退出' },
]

/** 遍历 cwd 下文件（深度≤3，跳过 node_modules/.git，上限 2000 个）做 @ 补全候选源 */
function listFiles(cwd: string, depth = 3): string[] {
  const out: string[] = []
  const walk = (dir: string, d: number) => {
    if (d > depth || out.length > 2000) return
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, d + 1)
      else out.push(path.relative(cwd, p))
    }
  }
  walk(cwd, 0)
  return out
}

export function computeSuggestions(input: string, env: { cwd: string; customCommands: Map<string, { template: string; source: 'user' | 'project' }>; skills?: { name: string; userInvocable: boolean; description?: string }[] }): Suggestion[] {
  if (input.startsWith('/') && !input.includes(' ')) {
    const builtinValues = new Set(BUILTIN_COMMANDS.map(b => b.value))
    const customNames = new Set(env.customCommands.keys())
    const invSkills = (env.skills ?? []).filter(s => s.userInvocable)
    // 命令正文首非空行作描述（.deepcode/commands 无 frontmatter，与 legacy skill 的描述派生一致）。
    const descOf = (tpl: string) => tpl.split('\n').map(l => l.trim()).find(l => l) ?? ''
    const suffixed = (desc: string, tag: string) => (desc ? `${desc} ${tag}` : tag)
    const byName = (a: [string, unknown], b: [string, unknown]) => a[0].localeCompare(b[0])
    // 自定义命令：仅被内置同名遮蔽（precedence 改为 builtin > 命令 > 技能）。
    const custom = [...env.customCommands.entries()].filter(([n]) => !builtinValues.has(`/${n}`))
    // 桶 1：用户命令（首句简写 + 来源后缀），字母序
    const b1 = custom.filter(([, c]) => c.source === 'user').sort(byName)
      .map(([n, c]) => ({ value: `/${n}`, hint: suffixed(firstSentence(descOf(c.template)), '(用户)') }))
    // 桶 2：项目命令，字母序
    const b2 = custom.filter(([, c]) => c.source === 'project').sort(byName)
      .map(([n, c]) => ({ value: `/${n}`, hint: suffixed(firstSentence(descOf(c.template)), '(项目)') }))
    // 桶 3：技能（首句简写），跳过与内置同名 与 与自定义命令同名者。
    // 命令/技能分离：.deepcode/commands 虽也作 legacy 技能加载（供模型调用），但菜单以「命令」身份
    // 展示（带来源），故技能列排除同名命令——否则命令会以技能身份重复出现并丢失来源标注。
    const b3 = invSkills
      .filter(s => !builtinValues.has(`/${s.name}`) && !customNames.has(s.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => ({ value: `/${s.name}`, hint: firstSentence(s.description ?? '') }))
    // 桶 0：内置命令保留精选顺序。桶序：内置 → 用户命令 → 项目命令 → 技能。
    const all = [...BUILTIN_COMMANDS, ...b1, ...b2, ...b3]
    // 命令名内子串模糊匹配（/text 可搜到 /context），去掉前导 / 后在命令名内找子串
    const q = input.slice(1).toLowerCase()
    const filtered = all.filter(s => s.value.toLowerCase().includes(q))
    // 精确等于某命令全名时隐藏菜单，让回车直接提交（防死锁，见既有注释）
    if (all.some(s => s.value === input)) return []
    return filtered
  }
  const at = input.match(/@([\w./-]*)$/)
  if (at) {
    const q = at[1].toLowerCase()
    // 带目录的查询（含 /）按完整相对路径匹配，否则只按文件名模糊匹配
    const hit = q.includes('/')
      ? (f: string) => f.toLowerCase().includes(q)
      : (f: string) => path.basename(f).toLowerCase().includes(q)
    return listFiles(env.cwd)
      .filter(hit)
      .slice(0, 8)
      .map(f => ({ value: `@${f}`, hint: '' }))
  }
  return []
}
