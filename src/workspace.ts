import path from 'node:path'
import { canonPath } from './pathCanon.js'

/** abs 相对 root 的合法嵌套尾巴（''=root 自身）；不在 root 内（含 .. 逃逸）则 null。 */
const relTail = (abs: string, root: string): string | null => {
  const rel = path.relative(root, abs)
  if (rel === '') return ''
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel
}

/** p（绝对路径）是否在某个 root（绝对目录）之内（含 root 自身、后代；无 .. 逃逸）。
 *  归一化后比较：p 与 root 都先 realpath 解开软链（canonPath），再判嵌套关系——
 *  围栏内的软链一旦被解开就落到真实目标，若真实目标在围栏外即拒，逃逸因此被识破。
 *  root 同样归一化，否则 macOS 上 /tmp 与 /private/tmp 不一致会把合法路径全拦掉。 */
export function isInsideWorkspace(p: string, roots: string[]): boolean {
  const real = canonPath(p)
  return roots.some(r => relTail(real, canonPath(r)) !== null)
}
