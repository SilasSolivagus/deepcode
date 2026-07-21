// src/tui/hashMemory.ts
// 行首 `#` 快速记忆：在输入框行首打 `#` 加内容 → 弹作用域选择器
// （项目 DEEPCODE.md / 全局 ~/.deepcode/DEEPCODE.md）→ 把内容作为一行 `- ` bullet 追加进所选文件。
// 解析触发 + 内容转换是纯函数；文件写入是薄 fs 包装（UI 接线在 App/FullscreenApp）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type MemoryScope = 'project' | 'global'

/**
 * 识别行首 `#` 快速记忆。严格要求首字符为 `#`（无前导空白），避免误伤 markdown 标题/代码粘贴。
 * `#` 之后的文本 trim 后即记忆内容；无内容（只有 `#` 或 `#` + 空白）返回 null 不触发。
 */
export function parseHashMemory(input: string): string | null {
  if (input.charAt(0) !== '#') return null
  const text = input.slice(1).trim()
  return text.length > 0 ? text : null
}

/**
 * 把一条记忆作为一行 `- <text>` bullet 追加到已有文件内容后。归一已有内容的结尾换行为单个，
 * 再接 bullet + 单个结尾换行。空内容 → 仅 bullet。text 假定已 trim（由 parseHashMemory 负责）。
 */
export function appendMemoryBullet(existing: string, text: string): string {
  const base = existing.replace(/\n+$/, '')
  const prefix = base.length > 0 ? base + '\n' : ''
  return prefix + `- ${text}\n`
}

/** 作用域 → 目标文件。project=<cwd>/DEEPCODE.md；global=<home>/.deepcode/DEEPCODE.md。 */
export function resolveMemoryTarget(
  scope: MemoryScope, cwd: string, home: string = os.homedir(),
): string {
  return scope === 'project'
    ? path.join(cwd, 'DEEPCODE.md')
    : path.join(home, '.deepcode', 'DEEPCODE.md')
}

/** 把 text 作为一行 bullet 追加进作用域对应文件（缺目录自动建），返回写入的文件路径。 */
export function writeHashMemory(
  scope: MemoryScope, text: string, cwd: string, home: string = os.homedir(),
): string {
  const target = resolveMemoryTarget(scope, cwd, home)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let existing = ''
  try { existing = fs.readFileSync(target, 'utf8') } catch { /* 文件不存在 → 新建 */ }
  fs.writeFileSync(target, appendMemoryBullet(existing, text))
  return target
}
