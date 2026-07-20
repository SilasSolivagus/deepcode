import path from 'node:path'

/** memdir 下的保留子树：不是记忆，不参与扫描，记忆工具不可写入。 */
export const RESERVED_SUBTREES = ['team', 'logs', 'sessions', 'proposals'] as const

/** memdir 下不可被记忆工具改写的文件（dream 不能改自己的门控锁，谁也不能改写锁；.index.md 是归纳索引产物，不参与扫描）。 */
export const RESERVED_FILES = ['.consolidate-lock', '.write-lock', '.index.md'] as const

/** relPath 是 memdir 相对路径（posix 或 win32 分隔符均可）。 */
export function isReservedPath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return false
  // 首段命中 RESERVED_FILES 即拒，不限 parts.length===1：否则 `.write-lock/` 一旦真的以
  // 目录形式出现，会绕过保留检查，进而让 tryAcquireWriteLock 的 linkSync 永久拿不到锁
  // （EEXIST→EISDIR→null→重试→永远 null），且不算争抢型失败，静默失效永不见光。
  if ((RESERVED_FILES as readonly string[]).includes(parts[0])) return true
  return (RESERVED_SUBTREES as readonly string[]).includes(parts[0])
}

/** 返回 null 表示允许；否则返回拒绝原因。target 会先归一化，防 `../` 绕过。 */
export function assertNotReserved(memdir: string, target: string): string | null {
  const rel = path.relative(path.resolve(memdir), path.resolve(target))
  if (!isReservedPath(rel)) return null
  return `拒绝：${rel.split(/[\\/]/)[0]} 是保留子树/文件，记忆工具不可写入。`
}
