import fs from 'node:fs'
import path from 'node:path'
import { findGitRoot, sanitizeProjectKey } from './paths.js'

/**
 * ~/.deepcode/sessions/ 是全局扁平的（所有项目混放，文件名无项目键）。
 * 读每个会话首行的 meta.cwd → projectKey，只留本项目的。返回绝对路径，新→旧。
 * 单一事实源：countSessionsTouchedSince（dreamGate.ts）与 dream 会话白名单均消费本函数。
 */
export function listProjectSessions(
  sessionsDir: string, projectKey: string, sinceMs: number, excludeFile?: string,
): string[] {
  let files: string[]
  try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')) } catch { return [] }
  const cur = excludeFile ? path.basename(excludeFile) : null
  const out: { f: string; mtime: number }[] = []
  for (const f of files) {
    if (cur && f === cur) continue
    const full = path.join(sessionsDir, f)
    try {
      const firstLine = fs.readFileSync(full, 'utf8').split('\n')[0]
      let meta: any
      try { meta = JSON.parse(firstLine) } catch { continue }
      if (!meta?.cwd) continue
      if (sanitizeProjectKey(findGitRoot(meta.cwd) ?? meta.cwd) !== projectKey) continue
      const mtime = fs.statSync(full).mtimeMs
      if (mtime <= sinceMs) continue
      out.push({ f: full, mtime })
    } catch { /* 跳过损坏文件 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(x => x.f)
}
