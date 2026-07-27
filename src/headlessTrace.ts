// src/headlessTrace.ts
// headless（-p）stderr 轨迹的工具参数摘要：标识参数完整显示、diff 只给行数、500 字符保险丝。
// 与 TUI 的 formatToolArg 共享 toolArg.ts 的提取/清理逻辑，需要多字段的工具（Read/Edit/Write/Grep…）在此覆写。
import { clean, extractToolArg } from './tui/toolArg.js'

const HMAX = 500

export function headlessToolArg(name: string, desc: string): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(desc)
  } catch {
    return clean(desc, HMAX)
  }

  let out: string
  switch (name) {
    case 'Read': {
      const fp = String(args.file_path ?? '')
      const seg = args.offset != null || args.limit != null
        ? ` [offset:${args.offset ?? 0} limit:${args.limit ?? '∞'}]`
        : ''
      out = fp + seg
      break
    }
    case 'Edit': {
      const fp = String(args.file_path ?? '')
      const oldN = String(args.old_string ?? '').split('\n').length
      const newN = String(args.new_string ?? '').split('\n').length
      const all = args.replace_all === true ? ' (all)' : ''
      out = `${fp} +${newN}/-${oldN} 行${all}`
      break
    }
    case 'Write': {
      const fp = String(args.file_path ?? '')
      const n = String(args.content ?? '').split('\n').length
      out = `${fp} ${n} 行`
      break
    }
    case 'Bash':
      out = String(args.command ?? '')
      break
    case 'Grep': {
      const pat = String(args.pattern ?? '')
      const p = args.path ? ` path=${args.path}` : ''
      const g = args.glob ? ` glob=${args.glob}` : ''
      out = `pattern=${pat}${p}${g}`
      break
    }
    case 'Glob': {
      const pat = String(args.pattern ?? '')
      const p = args.path ? ` path=${args.path}` : ''
      out = `${pat}${p}`
      break
    }
    case 'Agent': {
      const d = String(args.description ?? '')
      const t = args.subagent_type ? ` [${args.subagent_type}]` : ''
      out = `${d}${t}`
      break
    }
    default:
      // TaskCreate / TaskUpdate / 未知工具：复用通用提取
      out = extractToolArg(name, desc)
  }
  return clean(out, HMAX)
}
