// src/pricing.ts
import { activeModelMeta } from './providers.js'

/** 非负有限数兜底：未归一的原始 usage 可能带 undefined/NaN，直接算成本会污染累计成 ¥NaN。 */
const num = (x: number): number => (Number.isFinite(x) ? Math.max(0, x) : 0)

/** 计算一次调用的人民币成本。未知模型走 active provider 的 defaultMeta（不再恒 0）。 */
export function costCNY(model: string, promptTokens: number, cacheHit: number, output: number): number {
  const p = activeModelMeta(model)
  const hit = Math.min(num(promptTokens), num(cacheHit))
  const miss = Math.max(0, num(promptTokens) - hit)
  return (hit * p.hit + miss * p.miss + num(output) * p.out) / 1_000_000
}

/** 缓存命中省下的人民币金额 = hitTokens × (miss − hit) / 1e6。 */
export function cacheSavingsCNY(model: string, hitTokens: number): number {
  const p = activeModelMeta(model)
  return (num(hitTokens) * (p.miss - p.hit)) / 1_000_000
}
