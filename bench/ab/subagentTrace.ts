// 从请求侧轨迹恢复子代理的执行记录。
//
// 为什么需要它：子代理跑的是另一个 runLoop，它的 loop 事件在 subagentRunner 里被就地抽干，
// 从不落 stream-json 轨迹。但子代理的请求走的是同一个 chatStream，所以它跑过的命令与结果
// 早就随请求体落在 req-*.json 里了——只是此前主循环与子代理的记录同形、分不开（现在靠
// traceLabel 分得开了）。
//
// ⚠️ 这是事后重建，不是实时记录：轨迹记的是「发出去之前」的对话。src/loop.ts 的主循环
// 在工具结果 push 进 messages 之后一律进下一轮再发一次请求，只有模型本轮不再调工具时才
// 结束——所以**正常终止路径下最后一批结果一定会进下一次请求，不会漏**。真正会漏的只有
// 子代理非正常终止：撞 maxTurns（子代理是 30）、被中断、抛异常，这些情况下最后一批命令
// 没有再触发一次请求，读不到。已知伪影：验证者烧完 30 轮被截断时，轨迹里可见的最后一条
// 很可能是绿的，会被读成「没带红收工」，白送一次命中——这恰恰是最危险的场景，见
// bench/ab/README.md。
import fs from 'node:fs'
import path from 'node:path'

export interface SubagentRun {
  /** 类型前缀部分，如 `subagent:verification`（不含 `#spawnId` 后缀） */
  label: string
  /** spawn 身份：从 label 里 `#` 后的部分拆出（对应 subagentRunner.ts 的 agentId）。
   *  向后兼容：不带 `#` 的旧版标签记为空串——旧版标签无法区分同类型的多次并发 spawn，
   *  这是接受的已知局限（生产代码此后总是带 `#agentId`，只有历史轨迹才会缺失）。
   *  可选：recoverSubagentRuns 产出的记录总会填上它；判定器目前只按 label 分组，
   *  不依赖这个字段，标为可选以免手写测试夹具（如 ab.predicates.test.ts 的 subrun）被迫补填。 */
  spawnId?: string
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
 *  spawn 身份直接写在完整标签里（`subagent:<type>#<agentId>`，见 src/subagentRunner.ts），
 *  按完整标签分组即可天然区分不同 spawn——同一 spawn 内多轮累积的多条记录取 seq 最大的
 *  那条（messages 最全）；不同 spawn（不同 agentId）自成一组，天然互不干扰，即便两个
 *  同类型子代理并发、请求交错落盘也不受影响。不再需要任何基于 messages.length 的切分
 *  启发式。返回时把完整标签拆回 label（# 前）与 spawnId（# 后），按各组的最大 seq 升序排列。
 *  向后兼容：不带 `#` 的旧版标签整条视为一个分组（spawnId 记空串）——旧版标签本就无法
 *  区分同类型的多次并发 spawn，这是接受的已知局限，不是本函数要修的问题。 */
export function recoverSubagentRuns(traceDir: string, labelPrefix: string): SubagentRun[] {
  let names: string[]
  try { names = fs.readdirSync(traceDir) } catch { return [] } // 没开轨迹就没这个目录

  // 按完整标签（含 #spawnId 后缀，若有）分组
  const byFullLabel = new Map<string, Array<{ seq: number; messages: any[] }>>()
  for (const name of names) {
    if (!FILE_RE.test(name)) continue
    let rec: any
    try { rec = JSON.parse(fs.readFileSync(path.join(traceDir, name), 'utf8')) } catch { continue } // 坏文件跳过
    const fullLabel = rec?.label
    if (typeof fullLabel !== 'string' || !fullLabel.startsWith(labelPrefix)) continue
    if (!Array.isArray(rec.messages)) continue
    const seq = typeof rec.seq === 'number' ? rec.seq : -1
    if (!byFullLabel.has(fullLabel)) byFullLabel.set(fullLabel, [])
    byFullLabel.get(fullLabel)!.push({ seq, messages: rec.messages })
  }

  // 每组取 seq 最大的一条，再按各组最大 seq 升序排列
  const groups: Array<{ fullLabel: string; seq: number; messages: any[] }> = []
  for (const [fullLabel, recs] of byFullLabel.entries()) {
    const best = recs.reduce((a, b) => (b.seq > a.seq ? b : a))
    groups.push({ fullLabel, seq: best.seq, messages: best.messages })
  }
  groups.sort((a, b) => a.seq - b.seq)

  return groups.map(g => {
    const hashIdx = g.fullLabel.indexOf('#')
    const label = hashIdx < 0 ? g.fullLabel : g.fullLabel.slice(0, hashIdx)
    const spawnId = hashIdx < 0 ? '' : g.fullLabel.slice(hashIdx + 1)
    return { label, spawnId, ...pairFromMessages(g.messages) }
  })
}
