// src/infoCommands.ts —— /status /skills /hooks /mcp 只读信息命令的纯格式化器。
// 把 deepcode 已发布但「零发现性」的子系统（技能/hook/MCP）暴露给用户查看。
import type { SkillDefinition } from './skillsLoader.js'
import type { HooksConfig, HookCommand } from './hooks.js'
import type { SettingScope } from './settingsLayers.js'
import { normalizeNameForMCP } from './mcp.js'

const firstLine = (s: string): string => s.split('\n').map(l => l.trim()).find(l => l) ?? ''

/** /skills：列出模型可调用的技能（名 + 描述首行）。 */
export function formatSkillsList(skills: SkillDefinition[]): string {
  const inv = skills.filter(s => s.modelInvocable)
  if (!inv.length) return '（无模型可调用的技能）'
  return `可用技能（${inv.length}）：\n` +
    inv.map(s => `· ${s.name}${s.description ? ` — ${firstLine(s.description)}` : ''}`).join('\n')
}

const hookContent = (h: HookCommand): string => {
  if (h.type === 'command') return h.command
  if (h.type === 'prompt' || h.type === 'agent') return h.prompt
  if (h.type === 'http') return h.url
  return ''
}
const truncHook = (s: string, n = 120): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** /hooks：按事件列出每条 hook 的 matcher/类型/内容/来源层（hooks 仅 user/flag 层可能，project/tracked-local 已剥离）。 */
export function formatHooksConfig(
  hookLayers: { scope: SettingScope; hooks: HooksConfig }[],
): string {
  const byEvent = new Map<string, { matcher?: string; hook: HookCommand; scope: string }[]>()
  for (const layer of hookLayers) {
    for (const [event, arr] of Object.entries(layer.hooks ?? {})) {
      if (!Array.isArray(arr)) continue
      for (const m of arr) {
        for (const h of m.hooks) {
          if (!byEvent.has(event)) byEvent.set(event, [])
          byEvent.get(event)!.push({ matcher: m.matcher, hook: h, scope: layer.scope })
        }
      }
    }
  }
  if (!byEvent.size) return '（未配置任何 hook；在 settings.json 的 hooks 里配置）'
  const lines: string[] = []
  for (const [event, entries] of byEvent) {
    lines.push(`${event}:`)
    for (const e of entries) {
      const matcher = e.matcher && e.matcher !== '*' ? ` [${e.matcher}]` : ''
      const content = hookContent(e.hook)
      lines.push(`  ·${matcher} ${e.hook.type}${content ? ` · ${truncHook(content)}` : ''} [${e.scope}]`)
    }
  }
  return `已配置的 hook：\n${lines.join('\n')}`
}

/** /mcp：列出 MCP server 三态（pending/connected/failed）+ 错误原因 + 各自工具（名/数）。 */
export function formatMcpStatus(
  states: { name: string; status: 'pending' | 'connected' | 'failed'; error?: string }[],
  toolNames: string[],
): string {
  if (!states.length) return '（未配置 MCP server；在 settings.json 的 mcpServers 里配置）'
  const ICON = { connected: '✓', pending: '…', failed: '✗' } as const
  const LABEL = { connected: '已连接', pending: '连接中', failed: '连接失败' } as const
  const lines: string[] = []
  for (const s of states) {
    const prefix = `mcp__${normalizeNameForMCP(s.name)}__`
    const short = toolNames.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length))
    let head = `· ${s.name}：${ICON[s.status]} ${LABEL[s.status]}`
    if (s.status === 'connected') head += short.length ? `（${short.length} 个工具）` : '（无工具）'
    lines.push(head)
    if (s.status === 'failed' && s.error) {
      const e = s.error.length > 200 ? s.error.slice(0, 200) + '…' : s.error
      lines.push(`    错误：${e}`)
    }
    if (short.length) {
      const shown = short.length > 12 ? short.slice(0, 12).join('、') + ` …等 ${short.length} 个` : short.join('、')
      lines.push(`    工具：${shown}`)
    }
  }
  return `MCP server（${states.length}）：\n${lines.join('\n')}`
}

/** /doctor：安装/配置/连通性诊断。 */
export interface DoctorCheck { name: string; ok: boolean; detail?: string }
export function formatDoctor(checks: DoctorCheck[]): string {
  const bad = checks.filter(c => !c.ok).length
  const head = bad === 0 ? 'deepcode 诊断：全部正常 ✓' : `deepcode 诊断：${bad} 项需注意`
  const lines = checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `：${c.detail}` : ''}`)
  return `${head}\n${lines.join('\n')}`
}

/** /status：会话状态一览。 */
export interface StatusInfo {
  version: string; model: string; mode: string; cwd: string
  branch?: string; memoryCount: number; skillsCount: number
  mcpServerCount: number; toolCount: number
}
export function formatStatus(o: StatusInfo): string {
  return [
    `deepcode v${o.version}`,
    `模型：${o.model}`,
    `权限模式：${o.mode}`,
    `工作目录：${o.cwd}${o.branch ? `（分支 ${o.branch}）` : ''}`,
    `记忆文件：${o.memoryCount} · 技能：${o.skillsCount} · MCP server：${o.mcpServerCount} · 工具：${o.toolCount}`,
  ].join('\n')
}
