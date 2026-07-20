import fs from 'node:fs'
import path from 'node:path'
import { scanMemoryFiles } from '../../memdir/memoryScan.js'

export interface Candidate {
  index: number
  filePath: string
  filename: string
  projectKey: string
  type: string
  description: string | null
}

/**
 * 扫所有项目 memdir，列出 user/feedback 两类记忆作为「升格到全局」的候选。
 * 只列，不动。存量记忆写于「无 scope 概念 + 零注入防线」的年代，必须人工过一遍。
 */
export async function listPromotionCandidates(home: string): Promise<Candidate[]> {
  const base = path.join(home, '.deepcode', 'projects')
  let keys: string[]
  try { keys = fs.readdirSync(base) } catch { return [] }

  const out: Candidate[] = []
  for (const key of keys) {
    const memdir = path.join(base, key, 'memory')
    const heads = await scanMemoryFiles(memdir, 'project')
    for (const h of heads) {
      if (h.type !== 'user' && h.type !== 'feedback') continue
      out.push({
        index: out.length + 1,
        filePath: h.filePath,
        filename: h.filename,
        projectKey: key,
        type: h.type,
        description: h.description,
      })
    }
  }
  return out
}

/** 复制（不移动）到全局抽屉。源文件保留作回退；同名不覆盖。 */
export function promoteCandidate(c: Candidate, globalMemdir: string): string {
  const dest = path.join(globalMemdir, c.filename)
  if (fs.existsSync(dest)) return `全局抽屉里已存在 ${c.filename}，未覆盖。请先 /memory rm 掉旧的，或改名后再升格。`
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true }) // dest 可能在子目录（如 preferences/xxx.md），mkdir 覆盖 globalMemdir 本身
    fs.copyFileSync(c.filePath, dest)
  } catch (e: any) { return `升格失败：${e?.message ?? e}` }
  return `已升格 ${c.filename} 到全局抽屉（原文件保留在 ${c.projectKey}，确认无误后可自行删除）。`
}
