// 从请求侧轨迹恢复子代理的执行记录。
//
// 为什么需要它：子代理跑的是另一个 runLoop，它的 loop 事件在 subagentRunner 里被就地抽干，
// 从不落 stream-json 轨迹。但子代理的请求走的是同一个 chatStream，所以它跑过的命令与结果
// 早就随请求体落在 req-*.json 里了——只是此前主循环与子代理的记录同形、分不开（现在靠
// traceLabel 分得开了）。
//
// ⚠️ 这是事后重建，不是实时记录：轨迹记的是「发出去之前」的对话，所以子代理最后一轮
// 工具调用的结果永远看不到——那批结果只会出现在下一次请求里，若子代理那轮之后直接收工，
// 就没有下一次请求。本模块因此会系统性漏掉子代理的最后一批命令。
import fs from 'node:fs'
import path from 'node:path'

export interface SubagentRun {
  /** 完整标签，如 `subagent:verification` */
  label: string
  /** 该子代理跑过的 Bash 命令原文 */
  bashCommands: string[]
  /** 与 bashCommands 同序对应的结果原文 */
  bashResults: string[]
}

const FILE_RE = /^req-(\d{4,})\.json$/

/** 从一条记录的 wire messages 里按 tool_call_id 配对出命令与结果。
 *  用 id 配对而非「紧随其后」：同一轮可能有多个并发工具调用，相邻关系不可靠。 */
function pairFromMessages(messages: any[]): { bashCommands: string[]; bashResults: string[] } {
  const cmdById = new Map<string, string>()
  const order: string[] = []
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const c of m.tool_calls) {
      if (c?.function?.name !== 'Bash' || typeof c.id !== 'string') continue
      let cmd: unknown
      try { cmd = JSON.parse(c.function.arguments ?? '{}').command } catch { continue } // 参数畸形就跳过这一条
      if (typeof cmd !== 'string') continue
      cmdById.set(c.id, cmd)
      order.push(c.id)
    }
  }
  const resultById = new Map<string, string>()
  for (const m of messages) {
    if (m?.role === 'tool' && typeof m.tool_call_id === 'string' && typeof m.content === 'string') {
      resultById.set(m.tool_call_id, m.content)
    }
  }
  const bashCommands: string[] = []
  const bashResults: string[] = []
  for (const id of order) {
    const r = resultById.get(id)
    if (r === undefined) continue // 有命令没结果＝轨迹在此截断，不产出半条记录
    bashCommands.push(cmdById.get(id)!)
    bashResults.push(r)
  }
  return { bashCommands, bashResults }
}

/** 恢复轨迹目录里各子代理的执行记录。目录不存在或无匹配记录时返回空数组。
 *  同一 label 只取 seq 最大的那条——请求是累积的，最后一条含最全的对话。 */
export function recoverSubagentRuns(traceDir: string, labelPrefix: string): SubagentRun[] {
  let names: string[]
  try { names = fs.readdirSync(traceDir) } catch { return [] } // 没开轨迹就没这个目录

  const latest = new Map<string, { seq: number; messages: any[] }>()
  for (const name of names) {
    if (!FILE_RE.test(name)) continue
    let rec: any
    try { rec = JSON.parse(fs.readFileSync(path.join(traceDir, name), 'utf8')) } catch { continue } // 坏文件跳过
    const label = rec?.label
    if (typeof label !== 'string' || !label.startsWith(labelPrefix)) continue
    if (!Array.isArray(rec.messages)) continue
    const seq = typeof rec.seq === 'number' ? rec.seq : -1
    const prev = latest.get(label)
    if (!prev || seq > prev.seq) latest.set(label, { seq, messages: rec.messages })
  }

  return [...latest.entries()].map(([label, v]) => ({ label, ...pairFromMessages(v.messages) }))
}
