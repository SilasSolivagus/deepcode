// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Silas <dirctable@gmail.com>
// deepcode — https://github.com/SilasSolivagus/deepcode
// src/streamJson.ts
// headless --output-format stream-json 的事件序列化：把 LoopEvent 与首尾事件转成自建 schema 的 JSONL。
// 自建 schema，字段名用公共词汇（type/session_id/id/content/usage），不逐字节兼容任何其它产品。
import type { LoopEvent } from './loop.js'
import type { HeadlessResult } from './headless.js'

/** 工具参数 JSON 串 → 对象；解析失败包成 { raw }，不丢信息不抛。 */
export function parseToolInput(desc: string): unknown {
  try {
    return JSON.parse(desc)
  } catch {
    return { raw: desc }
  }
}

export function streamInit(o: { sessionId: string; cwd: string; model: string; yolo: boolean }): string {
  return JSON.stringify({ type: 'init', session_id: o.sessionId, cwd: o.cwd, model: o.model, yolo: o.yolo }) + '\n'
}

/** 把一个 LoopEvent 转成一行 JSONL；不需要流出的事件返回 null。 */
export function streamFromLoopEvent(ev: LoopEvent): string | null {
  switch (ev.type) {
    case 'text':
      return JSON.stringify({ type: 'text', delta: ev.delta, reasoning: ev.reasoning ?? false }) + '\n'
    case 'tool_start':
      return JSON.stringify({ type: 'tool_start', id: ev.id, name: ev.name, input: parseToolInput(ev.desc) }) + '\n'
    case 'tool_end':
      return JSON.stringify({ type: 'tool_result', id: ev.id, ok: ev.ok, content: ev.content, ms: ev.ms }) + '\n'
    case 'turn_end':
      return JSON.stringify({ type: 'turn_end', usage: ev.usage }) + '\n'
    default:
      return null
  }
}

export function streamResult(r: HeadlessResult): string {
  return JSON.stringify({ type: 'result', status: r.status, turns: r.turns, usage: r.usage, costCNY: r.costCNY, text: r.text }) + '\n'
}

/** 解析 --output-format；缺省 text，--json 作 json 别名，--output-format 优先。非法值抛错。 */
export function parseOutputFormat(argv: string[]): 'text' | 'json' | 'stream-json' {
  const i = argv.indexOf('--output-format')
  if (i >= 0) {
    const v = argv[i + 1]
    if (v === 'text' || v === 'json' || v === 'stream-json') return v
    throw new Error(`--output-format 只支持 text|json|stream-json，收到：${v}`)
  }
  return argv.includes('--json') ? 'json' : 'text'
}
