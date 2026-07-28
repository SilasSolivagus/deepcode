import path from 'node:path'
import { canonPath } from './pathCanon.js'

/** abs 相对 root 的合法嵌套尾巴（''=root 自身）；不在 root 内（含 .. 逃逸）则 null。 */
const relTail = (abs: string, root: string): string | null => {
  const rel = path.relative(root, abs)
  if (rel === '') return ''
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel
}

/** p（绝对路径）是否在某个 root（绝对目录）之内（含 root 自身、后代；无 .. 逃逸）。
 *  双路径取交集：逻辑与真实互相印证——先在逻辑或真实两种形态下确认 p 相对 root 的嵌套尾巴，
 *  再用 root 的真实路径拼回该尾巴重建出的路径，必须与 p 的真实路径（canonPath）完全一致；
 *  一致说明中间没有被软链改道（root 上方的平台别名如 /tmp↔/private/tmp 除外，那属于合法归一化），
 *  不一致（如围栏内的软链把尾巴导向围栏外）即判定为围栏外。roots 同样双形态尝试，
 *  否则 macOS 上 /tmp 与 /private/tmp 不匹配会把合法路径全拦掉。 */
export function isInsideWorkspace(p: string, roots: string[]): boolean {
  const rawTarget = path.resolve(p)
  const realTarget = canonPath(p)
  return roots.some(root => {
    const realRoot = canonPath(root)
    const rootForms = [path.resolve(root), realRoot]
    for (const targetForm of [rawTarget, realTarget]) {
      for (const rootForm of rootForms) {
        const tail = relTail(targetForm, rootForm)
        if (tail === null) continue
        const reconstructed = tail === '' ? realRoot : path.join(realRoot, tail)
        if (reconstructed === realTarget) return true
      }
    }
    return false
  })
}
