// src/tui/toolArg.ts
// 纯函数：从工具调用的原始 JSON 参数串提取主参数。无副作用（不碰 fs / ink），便于单测。
// 拆两层：extractToolArg（提取标识字段，无截断）+ clean（折叠控制字符 + 可传上限截断）。
// formatToolArg（TUI）= clean∘extract，截 60；headless 侧另用 clean(…, 500)（见 headlessTrace.ts）。
const MAX = 60

/** 折叠换行/控制字符为空格，超 maxLen 截断加 …（缺省 60）。*/
export function clean(s: string, maxLen = MAX): string {
  const collapsed = s.replace(/[\n\r\t]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) + '…' : collapsed
}

/** 按工具类型提取标识主参数，不截断。JSON 解析失败返回原 desc。 */
export function extractToolArg(name: string, desc: string): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(desc)
  } catch {
    return desc
  }
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return String(args.file_path ?? '')
    case 'Bash':
      return String(args.command ?? '')
    case 'Grep':
    case 'Glob': {
      const pat = String(args.pattern ?? '')
      const p = args.path ? ` ${args.path}` : ''
      return `${pat}${p}`
    }
    case 'Agent':
      return String(args.description ?? '')
    case 'TaskCreate':
      return String(args.subject ?? '')
    case 'TaskUpdate':
      return `#${String(args.taskId ?? '')}${args.status ? ` → ${args.status}` : ''}`
    default: {
      const first = Object.values(args).find(v => typeof v === 'string')
      return typeof first === 'string' ? first : ''
    }
  }
}

export function formatToolArg(name: string, desc: string): string {
  return clean(extractToolArg(name, desc), MAX)
}
