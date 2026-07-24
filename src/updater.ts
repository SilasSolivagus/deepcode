// src/updater.ts
// 自动升级子系统：版本比较、安装形态检测、节流闸、状态机、编排。
// 纯逻辑与副作用分离——副作用（网络/子进程/文件）全部经 deps 注入，便于单测。
// 安全：包名为模块常量；升级命令固定 argv 数组，registry 返回的字符串绝不进命令行。

/** npm 包名。硬编码常量，不从任何配置读取（杜绝注入面）。 */
export const PKG = '@silassolivagus/deepcode'

/** 版本检查节流间隔：24 小时。 */
export const CHECK_INTERVAL_MS = 86_400_000

/** 解析 x.y.z（忽略 +build 后缀）；含预发布标记或格式非法 → null。 */
function parseVersion(v: string): [number, number, number] | null {
  if (typeof v !== 'string') return null
  const core = v.split('+')[0].trim()
  if (core.includes('-')) return null // 预发布版：保守不参与比较
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(core)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** semver 比较。忽略 +build；任一侧预发布或非法 → 0（判为「不升级」）。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a), pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

/** 节流状态（落 ~/.deepcode/update.json）。 */
export interface UpdateCheckState { lastCheckAt: number; latest?: string }

/** 距上次检查是否已超过间隔。state 缺失/损坏/时间戳非法 → true。 */
export function shouldCheck(state: UpdateCheckState | null, now: number, intervalMs = CHECK_INTERVAL_MS): boolean {
  if (!state) return true
  const last = state.lastCheckAt
  if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0 || last > now) return true
  return now - last >= intervalMs
}
