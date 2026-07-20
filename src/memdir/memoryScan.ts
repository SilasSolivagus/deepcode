import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from '../agentsLoader.js'
import { isMemoryType, type MemoryType } from './memoryTypes.js'
import { isReservedPath } from './reserved.js'

export const MAX_MEMORY_FILES = 200

/** 记忆所属抽屉。由文件所在物理目录派生——不读 frontmatter，不信任文件自报。 */
export type MemoryScope = 'project' | 'global'

export interface MemoryHeader {
  filename: string
  filePath: string
  scope: MemoryScope
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

/** 跨抽屉唯一的身份键。两个抽屉可能有同名文件，裸 filename 会碰撞。 */
export function memoryKey(h: MemoryHeader): string {
  return `${h.scope}:${h.filename}`
}

export async function scanMemoryFiles(memdir: string, scope: MemoryScope = 'project'): Promise<MemoryHeader[]> {
  let entries: string[]
  try {
    entries = (await fs.readdir(memdir, { recursive: true }) as string[])
      .filter(f => f.endsWith('.md') && path.basename(f) !== 'MEMORY.md' && !isReservedPath(f))
  } catch { return [] }

  const heads = await Promise.all(entries.map(async (filename): Promise<MemoryHeader | null> => {
    const filePath = path.join(memdir, filename)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return null
      const head = (await fs.readFile(filePath, 'utf8')).split('\n').slice(0, 30).join('\n')
      const { data } = parseFrontmatter(head + '\n')
      const desc = typeof data.description === 'string' ? data.description : null
      const type = isMemoryType(data.type) ? data.type : undefined
      return { filename, filePath, scope, mtimeMs: stat.mtimeMs, description: desc, type }
    } catch { return null }
  }))

  return heads.filter((h): h is MemoryHeader => h !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES)
}

/**
 * 两个抽屉各自独立 MAX_MEMORY_FILES 配额，合并返回（全局在前）。
 * 不能合并成单一 400 配额：项目 churn 远快于全局，按 mtime 排序会让项目噪声把
 * 珍贵的全局偏好挤出清单，等于废掉全局抽屉。
 */
export async function scanAllMemories(projectMemdir: string, globalMemdir?: string): Promise<MemoryHeader[]> {
  const [glob, proj] = await Promise.all([
    globalMemdir ? scanMemoryFiles(globalMemdir, 'global') : Promise.resolve([]),
    scanMemoryFiles(projectMemdir, 'project'),
  ])
  return [...glob, ...proj]
}

export function formatMemoryManifest(headers: MemoryHeader[]): string {
  if (!headers.length) return '（暂无记忆文件）'
  return headers.map(h => `- ${memoryKey(h)} [${h.type ?? '?'}]: ${h.description ?? '(无描述)'}`).join('\n')
}
