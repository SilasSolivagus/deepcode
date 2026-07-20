import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const MAX_KEY_LEN = 200

export function sanitizeProjectKey(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9]/g, '-')
  if (clean.length <= MAX_KEY_LEN) return clean
  const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
  return clean.slice(0, MAX_KEY_LEN) + '-' + hash
}

/** 向上找含 .git（目录或文件，支持 worktree）的目录，realpath 归一；找不到返回 null。 */
export function findGitRoot(cwd: string): string | null {
  let dir = path.resolve(cwd)
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return fs.realpathSync(dir)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function projectsBase(home: string): string {
  return path.join(home, '.deepcode', 'projects')
}

/** memdir：项目键用 git root（同 repo 多 worktree 共享），非 git fallback cwd。 */
export function memdirFor(cwd: string, home: string = os.homedir()): string {
  const key = sanitizeProjectKey(findGitRoot(cwd) ?? path.resolve(cwd))
  return path.join(projectsBase(home), key, 'memory')
}

/**
 * 全局记忆抽屉：跨所有项目共享的「关于你这个人」的记忆。
 * 与 projects/ 平级，不挂在任何项目键下 —— 它不属于任何项目。
 * home 必须可注入：禁止裸调 os.homedir()，否则测试会写脏用户真实目录。
 */
export function globalMemdirFor(home: string = os.homedir()): string {
  return path.join(home, '.deepcode', 'memory')
}

/** session-memory：项目键用 cwd（非 git root），+ sessionId 子目录 + summary.md。 */
export function sessionMemoryPathFor(cwd: string, sessionId: string, home: string = os.homedir()): string {
  const key = sanitizeProjectKey(path.resolve(cwd))
  return path.join(projectsBase(home), key, sessionId, 'session-memory', 'summary.md')
}

/** plan 文件目录：项目键同 memdir（git root，非 git fallback cwd）+ plans 子目录。 */
export function planDirFor(cwd: string, home: string = os.homedir()): string {
  const key = sanitizeProjectKey(findGitRoot(cwd) ?? path.resolve(cwd))
  return path.join(projectsBase(home), key, 'plans')
}
