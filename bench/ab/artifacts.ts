// 从 stream-json 轨迹里抽出判定器需要的那几样东西。
//
// 轨迹的六类事件里，本模块只用 tool_start（取 Bash 命令）与 result（取 status/turns）。
// 坏行跳过而不整体失败——一次跑是花了钱和时间的，不该因为一行畸形 JSON 就全丢。
import type { RunArtifacts } from './predicates.js'

export function extractArtifacts(input: {
  traceJsonl: string
  exitCode: number
  outputDir: string
}): RunArtifacts {
  const bashCommands: string[] = []
  let status = 'unknown'
  let turns = 0

  for (const raw of input.traceJsonl.split('\n')) {
    if (!raw.trim()) continue
    let o: any
    try { o = JSON.parse(raw) } catch { continue } // 坏行跳过
    if (o.type === 'tool_start' && o.name === 'Bash') {
      const cmd = o.input?.command ?? o.input?.cmd
      if (typeof cmd === 'string') bashCommands.push(cmd)
    } else if (o.type === 'result') {
      if (typeof o.status === 'string') status = o.status
      if (typeof o.turns === 'number') turns = o.turns
    }
  }

  return { bashCommands, exitCode: input.exitCode, status, turns, outputDir: input.outputDir }
}
