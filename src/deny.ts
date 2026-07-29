// src/deny.ts
// 敏感路径 deny：内置私钥类默认列表 + picomatch glob 匹配（~展开、逻辑路径与真实路径双判）。
import type { PermissionRuleSource } from './permissions.js'
import picomatch from 'picomatch'
import os from 'node:os'
import path from 'node:path'
import { canonPath } from './pathCanon.js'

/** 内置默认 deny（只含高敏私钥类；不含 .env 以免误伤读配置请求）。 */
export const BUILTIN_DENY = [
  '~/.ssh/**',
  '**/id_rsa',
  '**/id_ed25519',
  '**/id_dsa',
  '**/id_ecdsa',
  '~/.aws/credentials',
  '**/authorized_keys',
]

/** 转义 picomatch 元字符（仅用于 homedir 字面段，不影响 glob 后缀活性）。 */
function escapeGlob(s: string): string {
  return s.replace(/[()[\]{}!?*+@|^$.\\]/g, m => '\\' + m)
}

function expandTilde(p: string): string {
  if (p === '~') return escapeGlob(os.homedir())
  return p.startsWith('~/') ? escapeGlob(os.homedir()) + '/' + p.slice(2) : p
}

/** absPath 命中任一 deny pattern 则返回该 pattern，否则 null。
 *  双路径取并集：逻辑路径与真实路径任一命中即拒。
 *  只判真实路径会反向失效——规则若按逻辑路径写（如 ~/.ssh/**）而该目录本身是软链，
 *  归一化后就不再匹配那条 glob，原本被拒的会变成放行。 */
export function isDeniedPath(absPath: string, patterns: string[]): string | null {
  const logical = path.resolve(absPath)
  const real = canonPath(absPath)
  for (const pat of patterns) {
    const expanded = expandTilde(pat)
    if (picomatch.isMatch(logical, expanded, { dot: true })) return pat
    if (real !== logical && picomatch.isMatch(real, expanded, { dot: true })) return pat
  }
  return null
}

/** 运行时 deny 列表 = 内置默认 ∪ 用户配置。 */
export function resolveDenyList(userDeny?: string[]): string[] {
  return [...BUILTIN_DENY, ...(userDeny ?? [])]
}

/** deny pattern → 来源映射：内置规则标 'builtin'，并入 config deny 的 scope（同名 config 覆盖 builtin）。 */
export function buildDenySourceMap(
  configDenySources?: Record<string, PermissionRuleSource>,
): Record<string, PermissionRuleSource> {
  const out: Record<string, PermissionRuleSource> = {}
  for (const pat of BUILTIN_DENY) out[pat] = 'builtin'
  if (configDenySources) for (const [pat, src] of Object.entries(configDenySources)) out[pat] = src
  return out
}
