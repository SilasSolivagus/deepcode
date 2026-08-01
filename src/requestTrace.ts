// 请求侧轨迹：把真正发给模型的东西原样落盘。
// 设计见 docs/superpowers/specs/2026-08-01-deepcode-request-trace-design.md
//
// 为什么捕获点在 chatStream 内而不是各调用方：chatStream 是所有出站请求的唯一收口，
// 且 wire payload 就在其内部组装。在此处挂钩 = 捕获真正上线的字节，构造上不可能漏。
// 「只记已知注入项」的替代方案依赖一张人工清单，而清单漏一类就是新盲区——那正是本项目要治的病。

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
