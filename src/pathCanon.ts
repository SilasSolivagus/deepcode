// src/pathCanon.ts —— 共享路径归一化。权限判定（围栏/deny）与记忆子系统共用。
import fs from 'node:fs'
import path from 'node:path'

/** 归一化：`../` 折叠 + symlink 解析。
 *  路径不存在时（如尚未创建的文件）解析最深的存在祖先再拼回剩余段，
 *  否则 /var → /private/var 这类平台 symlink 会让存在与不存在的路径归一化结果不可比。
 *  ⚠️ 折叠顺序是词法优先：先对整条路径做字符串层面的 `..` 折叠，再解析 symlink；
 *  真实 OS 路径解析是反过来的（逐段解析，遇到 symlink 立即替换，`..` 相对的是解析后的
 *  实际所在目录，不是原始书写路径里的上一级）。当 `..` 跨过一个 symlink 段时两种顺序
 *  会得出不同结果（如 `<repo>/lnk/../evil.txt`，lnk 指向 repo 之外）。因此本函数只适用于
 *  「判定与执行共用同一个 `path.resolve` 产出串」的场景——判定用 canonPath、执行也拿
 *  同一份原始串交给同一个解析器，两边天然一致。若消费者会把原始串交给 OS/shell 自行解析
 *  （不同解析器、不同顺序），canonPath 的判定结果可能与实际落盘位置分歧，不能直接当作
 *  该场景的围栏依据。 */
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
