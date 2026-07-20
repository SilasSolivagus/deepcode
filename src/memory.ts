// src/memory.ts
import path from 'node:path'

/** 纯格式化：把已找到的记忆文件列表（findMemoryFiles 的结果）拼成 /memory 的展示串。零副作用、不读 fs。 */
export function formatMemory(found: string[], home: string): string {
  const global = path.join(home, '.deepcode', 'DEEPCODE.md')
  const lines: string[] = []

  if (found.length === 0) {
    lines.push('当前没有生效的记忆文件。')
  } else {
    lines.push('当前生效的记忆文件：')
    for (const p of found) lines.push(`  ${p}`)
  }

  if (!found.includes(global)) {
    lines.push(`全局记忆 ${global} 不存在，可创建。`)
  }

  lines.push('用 /init 生成项目 DEEPCODE.md；或直接用编辑器编辑上述文件 / 全局 ~/.deepcode/DEEPCODE.md。')

  return lines.join('\n')
}

export interface GlobalEntry {
  index: number
  filename: string
  filePath: string
  type?: string
  description?: string
  origin?: string
  created?: string
}

/**
 * /memory 的分段视图：指令文件（手写，直接编辑）+ 全局记忆抽屉（机器自动沉淀，可删）。
 * origin/created 是 frontmatter 里的戳，供参考而非权威溯源（MemEdit 不重新盖戳，模型可改写）——
 * 展示为中性的「来自 X · 日期」，不做成审计断言式措辞。
 */
export function formatMemoryView(instructionFiles: string[], globals: GlobalEntry[], home: string): string {
  const lines: string[] = []

  lines.push('## 指令文件（你手写的，直接编辑）')
  if (!instructionFiles.length) lines.push('  （无）')
  else for (const p of instructionFiles) lines.push(`  ${p}`)
  const g = path.join(home, '.deepcode', 'DEEPCODE.md')
  if (!instructionFiles.includes(g)) lines.push(`  （全局 ${g} 不存在，可创建）`)

  lines.push('')
  lines.push('## 全局记忆抽屉（自动沉淀，在所有项目生效）')
  if (!globals.length) {
    lines.push('  暂无跨项目记忆。')
  } else {
    for (const e of globals) {
      const meta = [e.type && `[${e.type}]`, e.origin && `来自 ${e.origin}`, e.created].filter(Boolean).join(' · ')
      lines.push(`  [${e.index}] ${e.filename} — ${e.description ?? '(无描述)'}`)
      if (meta) lines.push(`      ${meta}`)
    }
    lines.push('')
    lines.push('  用 /memory rm <编号> <文件名> 删除某条（删错了的、不该跨项目的）。')
    lines.push('  文件名以列表里那一行为准（防止列表在你确认编号后又变化，删错文件）。')
  }

  return lines.join('\n')
}
