import type { TranscriptItem } from './useChat.js'

export interface CollapsedCounts {
  readCount: number; searchCount: number; editFileCount: number
  linesAdded: number; linesRemoved: number; bashCount: number
  taskCount: number; webCount: number; mcpCallCount: number; otherCount: number
}

export const BRIEF_STANDALONE = new Set<string>(['AskUserQuestion', 'ExitPlanMode'])

function emptyCounts(): CollapsedCounts {
  return { readCount: 0, searchCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, bashCount: 0, taskCount: 0, webCount: 0, mcpCallCount: 0, otherCount: 0 }
}

function hasCounts(c: CollapsedCounts): boolean {
  return c.readCount || c.searchCount || c.editFileCount || c.bashCount || c.taskCount || c.webCount || c.mcpCallCount || c.otherCount ? true : false
}

function tally(c: CollapsedCounts, name: string, item: any): void {
  switch (name) {
    case 'Read': c.readCount++; break
    case 'Grep': case 'Glob': c.searchCount++; break
    case 'Edit': case 'Write': case 'NotebookEdit':
      c.editFileCount++
      if (typeof item?.linesAdded === 'number') c.linesAdded += item.linesAdded
      if (typeof item?.linesRemoved === 'number') c.linesRemoved += item.linesRemoved
      break
    case 'Bash': c.bashCount++; break
    case 'Task': case 'Agent': c.taskCount++; break
    case 'WebSearch': case 'WebFetch': c.webCount++; break
    default:
      if (name?.startsWith('mcp__') || name === 'Skill') c.mcpCallCount++
      else c.otherCount++
  }
}

/** 折叠门控：仅当全屏渲染器组件 且 focus 视图开启时才折叠 transcript（内联组件恒不折叠）。 */
export function shouldFold(isFullscreenComponent: boolean, focusMode: boolean): boolean {
  return isFullscreenComponent && focusMode
}

export function foldTranscript(items: TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  let counts = emptyCounts()
  let lastAsst: TranscriptItem | null = null
  let seg = 0
  const flush = () => {
    if (hasCounts(counts)) out.push({ kind: 'collapsed', id: `brief-${seg}`, counts } as TranscriptItem)
    if (lastAsst) out.push(lastAsst)
    counts = emptyCounts(); lastAsst = null; seg++
  }
  for (const it of items) {
    if (!it || !(it as any).kind) continue
    switch (it.kind) {
      case 'user': flush(); out.push(it); break
      case 'assistant': lastAsst = it; break
      case 'tool': {
        const name = (it as any).name ?? ''
        if (BRIEF_STANDALONE.has(name)) { flush(); out.push(it) }
        else tally(counts, name, it)
        break
      }
      case 'reasoning': case 'usage': break // 隐藏
      case 'notice': case 'bang': flush(); out.push(it); break
      default: out.push(it)
    }
  }
  flush()
  return out
}

export function summarizeCounts(c: CollapsedCounts): string {
  const parts: string[] = []
  if (c.readCount > 0) parts.push(`读取 ${c.readCount} 个文件`)
  if (c.searchCount > 0) parts.push(`搜索 ${c.searchCount} 次`)
  if (c.editFileCount > 0) {
    let p = `编辑 ${c.editFileCount} 个文件`
    if (c.linesAdded > 0 || c.linesRemoved > 0) {
      const a = c.linesAdded > 0 ? `+${c.linesAdded}` : ''
      const r = c.linesRemoved > 0 ? `-${c.linesRemoved}` : ''
      p += ` (${[a, r].filter(Boolean).join(' ')})`
    }
    parts.push(p)
  }
  if (c.bashCount > 0) parts.push(`运行 ${c.bashCount} 条命令`)
  if (c.taskCount > 0) parts.push(`运行 ${c.taskCount} 个子代理`)
  if (c.webCount > 0) parts.push(`抓取 ${c.webCount} 个来源`)
  if (c.mcpCallCount > 0) parts.push(`调用 ${c.mcpCallCount} 个工具`)
  if (c.otherCount > 0) parts.push(`${c.otherCount} 项其它操作`)
  return parts.join(' · ')
}
