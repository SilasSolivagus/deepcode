// src/pathCanon.ts —— 共享路径归一化。权限判定（围栏/deny）与记忆子系统共用。
import fs from 'node:fs'
import path from 'node:path'

/** 归一化：`../` 折叠 + symlink 解析。
 *  路径不存在时（如尚未创建的文件）解析最深的存在祖先再拼回剩余段，
 *  否则 /var → /private/var 这类平台 symlink 会让存在与不存在的路径归一化结果不可比。 */
export function canonPath(p: string): string {
  let cur = path.resolve(p)
  const rest: string[] = []
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest) } catch { /* 继续向上找 */ }
    const parent = path.dirname(cur)
    if (parent === cur) return path.resolve(p) // 到根仍不存在
    rest.unshift(path.basename(cur))
    cur = parent
  }
}
