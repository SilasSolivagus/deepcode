// 从 stream-json 轨迹里抽出判定器需要的那几样东西。
//
// 用到三类事件：tool_start（工具名与入参）、tool_result（结果原文）、result（status/turns）。
// tool_start 与 tool_result 靠 id 配对；seq 是 tool_start 的出现序号，供「FAIL 之后是否
// 又改了文件」这类顺序判定使用。
//
// 坏行跳过而不整体失败——一次跑是花了钱和时间的，不该因为一行畸形 JSON 就全丢。
import type { RunArtifacts } from './predicates.js'
import { recoverSubagentRuns } from './subagentTrace.js'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// 必须独占一行（正文里提到这个词，如「我准备写 VERDICT: PASS」，不该被当成判定）；
// 但对常见格式偏差宽容：加粗（提示词明令禁止但模型常犯）、冒号后多个空格、行首缩进。
// 不宽容的是：末尾多余文字（如句号）——那种情况判定本身就该算模糊，仍记 null。
const VERDICT_RE = /^\s*\**VERDICT:\s*\**\s*(PASS|FAIL|PARTIAL)\b/m
// 宽松得多：只判「这份报告里出现过 VERDICT 这个词」，不管格式对不对。用来把「格式偏了
// 导致解析不出」和「压根没给 verdict」区分开——前者 verdict=null 且这个字段为 true。
const VERDICT_WORD_RE = /verdict/i

export function extractArtifacts(input: {
  traceJsonl: string
  exitCode: number
  outputDir: string
  /** 请求侧轨迹目录；给了就顺带恢复子代理的执行记录（子代理不进 stream-json） */
  traceDir?: string
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
        agentSpawns.push({ subagentType: st.subagentType, verdict: m ? m[1] : null, sawVerdictLine: VERDICT_WORD_RE.test(content), report: content, seq: st.seq })
      }
    } else if (o.type === 'result') {
      if (typeof o.status === 'string') status = o.status
      if (typeof o.turns === 'number') turns = o.turns
    }
  }

  return { bashCommands, bashResults, editedFiles, agentSpawns, subagentRuns: input.traceDir ? recoverSubagentRuns(input.traceDir, 'subagent:') : [], exitCode: input.exitCode, status, turns, outputDir: input.outputDir }
}
