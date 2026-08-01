// 请求侧轨迹：把真正发给模型的东西原样落盘。
// 设计见 docs/superpowers/specs/2026-08-01-deepcode-request-trace-design.md
//
// 为什么捕获点在 chatStream 内而不是各调用方：chatStream 是所有出站请求的唯一收口，
// 且 wire payload 就在其内部组装。在此处挂钩 = 捕获真正上线的字节，构造上不可能漏。
// 「只记已知注入项」的替代方案依赖一张人工清单，而清单漏一类就是新盲区——那正是本项目要治的病。

import fs from 'node:fs'
import path from 'node:path'

export interface TraceRecord {
  seq: number
  ts: string
  label: string
  model: string
  messages: any[]
  tools: any[]
  params: Record<string, unknown>
}

/** 组装一条轨迹记录。纯函数：不碰磁盘、不读全局，好让 chatStream 之外能精确断言。 */
export function buildTraceRecord(input: {
  seq: number
  ts: string
  label?: string
  model: string
  wireMessages: any[]
  tools: any[]
  params: Record<string, unknown>
}): TraceRecord {
  return {
    seq: input.seq,
    ts: input.ts,
    label: input.label ?? 'unknown',
    model: input.model,
    messages: input.wireMessages,
    tools: input.tools,
    params: input.params,
  }
}

const FILE_RE = /^req-(\d{4})\.json$/

/** 扫已有轨迹取下一个编号。目录已存在且非空时续号，避免覆盖上一次跑的轨迹。 */
export function nextSeq(dir: string): number {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 1 // 目录不存在＝首次
  }
  let max = 0
  for (const n of names) {
    const m = FILE_RE.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** 落盘一条记录。任何失败都只警告不抛出——诊断功能绝不能让主流程失败。 */
export function writeTraceRecord(dir: string, rec: TraceRecord): boolean {
  try {
    const existed = fs.existsSync(dir)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!existed) {
      fs.chmodSync(dir, 0o700)
    }
    const file = path.join(dir, `req-${String(rec.seq).padStart(4, '0')}.json`)
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 })
    return true
  } catch (e) {
    process.stderr.write(`⚠ 请求轨迹落盘失败（已跳过该条）：${(e as Error).message}\n`)
    return false
  }
}
