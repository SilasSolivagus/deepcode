// 报告生成。
//
// 两条硬规矩，都是 #6 的教训换来的：
// ① 主判据（行为观察）必须打印两臂原始计数，不能只给 p 值——5/5 vs 0/5 和
//    5/5 vs 3/5 的 p 值差很远，但只看「不显著」三个字就都一样了。
// ② 次要指标那一节必须每次都印免责声明。#6 里总分 12/46 → 42/46 的提升，
//    全部由「这批恰好没生成某个 bug」解释，与被测改动无关——不每次提醒就会有人拿它说事。
import type { Declaration } from './declaration.js'
import type { RunArtifacts } from './predicates.js'
import { fisherOneTailed } from './stats.js'

export interface RunRecord {
  arm: string
  seed: number
  runDir: string
  artifacts: RunArtifacts
  observations: Record<string, boolean | null>
}

const DISCLAIMER =
  '> ⚠️ 次要指标受批次随机性主导，**不作主要依据**。#6 实测过：总分 12/46 → 42/46 的提升，' +
  '全部由「这一批恰好没生成某个 bug」解释，与被测改动无关。'

export function buildReport(input: {
  decl: Declaration
  records: RunRecord[]
  hashBefore: string
  hashAfter: string
  outRoot: string
}): string {
  const { decl, records, hashBefore, hashAfter, outRoot } = input
  const arms = Object.keys(decl.arms)
  const [armA, armB] = arms
  const L: string[] = []

  L.push(`# A/B 实验报告：${decl.id}`, '', decl.desc, '')

  if (hashBefore !== hashAfter) {
    L.push('## 🔴 本报告作废', '',
      '声明文件在跑动过程中被修改——判据变了，这轮结果不可信。', '',
      `- 跑前：\`${hashBefore}\``, `- 跑后：\`${hashAfter}\``, '')
  }

  L.push('## 配置', '',
    `- 声明 SHA256：\`${hashBefore}\``,
    `- 每臂 k = ${decl.k}`,
    ...arms.map(a => `- 臂 \`${a}\`：\`DEEPCODE_FLAGS=${JSON.stringify(decl.arms[a])}\``),
    `- 产出物：\`${outRoot}\``, '')

  L.push('## 主判据：行为观察', '',
    '每条观察在两臂各自的命中率，单尾 Fisher 精确检验。', '',
    `| 观察 | ${armA} | ${armB} | p（单尾） | 说明 |`,
    '|---|---|---|---|---|')

  for (const o of decl.observations) {
    const hit = (arm: string) => records.filter(r => r.arm === arm && r.observations[o.id] === true).length
    const valid = (arm: string) => records.filter(r => r.arm === arm && r.observations[o.id] !== null).length
    const [ha, hb, na, nb] = [hit(armA), hit(armB), valid(armA), valid(armB)]
    const p = fisherOneTailed(ha, na - ha, hb, nb - hb)
    L.push(`| \`${o.id}\` | **${ha}/${na}** | **${hb}/${nb}** | ${p.toFixed(4)} | ${o.desc} |`)
  }

  const nullCount = records.reduce(
    (n, r) => n + Object.values(r.observations).filter(v => v === null).length, 0)
  if (nullCount > 0) {
    L.push('', `⚠️ 有 ${nullCount} 条观察求值为 null（判定器不存在或抛异常），已排除在分母之外。`)
  }

  L.push('', '## 次要指标', '', DISCLAIMER, '',
    `| 臂 | 跑数 | 撞上限 | 平均轮次 | 非零退出 |`, '|---|---|---|---|---|')
  for (const arm of arms) {
    const rs = records.filter(r => r.arm === arm)
    const hitLimit = rs.filter(r => r.artifacts.status === 'max_turns').length
    const avgTurns = rs.length ? (rs.reduce((s, r) => s + r.artifacts.turns, 0) / rs.length).toFixed(1) : '—'
    const nonZero = rs.filter(r => r.artifacts.exitCode !== 0).length
    L.push(`| ${arm} | ${rs.length} | ${hitLimit} | ${avgTurns} | ${nonZero} |`)
  }

  L.push('', '## 每次跑', '', '| 臂 | seed | 状态 | 轮次 | 退出码 | 目录 |', '|---|---|---|---|---|---|')
  for (const r of [...records].sort((x, y) => x.arm.localeCompare(y.arm) || x.seed - y.seed)) {
    L.push(`| ${r.arm} | ${r.seed} | ${r.artifacts.status} | ${r.artifacts.turns} | ${r.artifacts.exitCode} | \`${r.runDir}\` |`)
  }

  L.push('', '## 局限', '',
    '1. **只测到 headless 覆盖的东西。** 只在 TUI 可达的路径（如 auto 模式权限分类器）本跑批器测不到。',
    '2. **单任务。** 结论不外推到其它任务类型。',
    `3. **k=${decl.k} 的功效有限。** 中等效应（如 5/5 vs 3/5，p≈0.44）判不出来——遇到这种结果，正确的结论是「效应弱或需要更大 k」，不是「无效」。`,
    '')

  return L.join('\n')
}
