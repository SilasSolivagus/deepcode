// 从 stream-json 轨迹里抽出判定器需要的那几样东西。
//
// 用到三类事件：tool_start（工具名与入参）、tool_result（结果原文）、result（status/turns）。
// tool_start 与 tool_result 靠 id 配对；seq 是 tool_start 的出现序号，供「FAIL 之后是否
// 又改了文件」这类顺序判定使用。
//
// 坏行跳过而不整体失败——一次跑是花了钱和时间的，不该因为一行畸形 JSON 就全丢。
import type { RunArtifacts } from './predicates.js'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// 必须独占一行：验证者正文里提到这个词（「我准备写 VERDICT: PASS」）不该被当成判定。
const VERDICT_RE = /^VERDICT: (PASS|FAIL|PARTIAL)$/m

export function extractArtifacts(input: {
  traceJsonl: string
  exitCode: number
  outputDir: string
}): RunArtifacts {
  const bashCommands: string[] = []
  const bashResults: RunArtifacts['bashResults'] = []
  const editedFiles: RunArtifacts['editedFiles'] = []
  const agentSpawns: RunArtifacts['agentSpawns'] = []
  let status = 'unknown'
  let turns = 0
  let seq = 0
  const pending = new Map<string, { name: string; seq: number; subagentType: string }>()

  for (const raw of input.traceJsonl.split('\n')) {
    if (!raw.trim()) continue
    let o: any
    try { o = JSON.parse(raw) } catch { continue } // 坏行跳过

    if (o.type === 'tool_start') {
      const mySeq = seq++
      if (typeof o.id === 'string') {
        pending.set(o.id, {
          name: String(o.name),
          seq: mySeq,
          subagentType: typeof o.input?.subagent_type === 'string' ? o.input.subagent_type : 'general-purpose',
        })
      }
      if (o.name === 'Bash') {
        const cmd = o.input?.command ?? o.input?.cmd
        if (typeof cmd === 'string') bashCommands.push(cmd)
      } else if (EDIT_TOOLS.has(o.name)) {
        // Edit/Write 用 file_path，NotebookEdit 用 notebook_path（各自 schema 已核实）
        const p = o.input?.file_path ?? o.input?.notebook_path
        if (typeof p === 'string') editedFiles.push({ path: p, seq: mySeq })
      }
    } else if (o.type === 'tool_result') {
      const st = typeof o.id === 'string' ? pending.get(o.id) : undefined
      if (!st) continue
      const content = typeof o.content === 'string' ? o.content : ''
      if (st.name === 'Bash') {
        bashResults.push({ content, seq: st.seq })
      } else if (st.name === 'Agent') {
        const m = VERDICT_RE.exec(content)
        agentSpawns.push({ subagentType: st.subagentType, verdict: m ? m[1] : null, report: content, seq: st.seq })
      }
    } else if (o.type === 'result') {
      if (typeof o.status === 'string') status = o.status
      if (typeof o.turns === 'number') turns = o.turns
    }
  }

  return { bashCommands, bashResults, editedFiles, agentSpawns, exitCode: input.exitCode, status, turns, outputDir: input.outputDir }
}
