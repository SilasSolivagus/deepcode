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
  /** I7：'na' = 本次跑不适用；'error' = 判定器不存在或抛异常。两者都不计入统计分母，但报告里分开印。 */
  observations: Record<string, boolean | 'na' | 'error'>
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
  // armA 恒为「实验臂」（声明里写死的 treatmentArm），armB 是另一个臂——不再依赖
  // Object.keys 的书写顺序。p 值检验的方向因此跟判据一样，是跑前就定死的。
  const armA = decl.treatmentArm
  const armB = arms.find(a => a !== armA)!
  const L: string[] = []

  L.push(`# A/B 实验报告：${decl.id}`, '', decl.desc, '')

  if (hashBefore !== hashAfter) {
    // 判据在跑动中被改，整份报告作废：不再往下拼主判据表、p 值、次要指标——
    // 只留作废说明、两个哈希、产出目录，让人自行去原始数据里复算。
    L.push('## 🔴 本报告作废', '',
      '声明文件在跑动过程中被修改——判据变了，这轮结果不可信。', '',
      `- 跑前：\`${hashBefore}\``, `- 跑后：\`${hashAfter}\``,
      `- 产出物：\`${outRoot}\`（原始数据还在，可自行核对）`, '')
    return L.join('\n')
  }

  L.push('## 配置', '',
    `- 声明 SHA256：\`${hashBefore}\``,
    `- 每臂 k = ${decl.k}`,
    ...arms.map(a => `- 臂 \`${a}\`：\`DEEPCODE_FLAGS=${JSON.stringify(decl.arms[a])}\``),
    `- 产出物：\`${outRoot}\``, '')

  L.push('## 主判据：行为观察', '',
    `「命中」＝该次跑的判定结果与声明里该观察的 \`expect\` 一致（\`expect: false\` 的观察，判定` +
    '结果为 `false` 才算命中，不是 `true`）。', '',
    `p 值检验的方向是「实验臂 \`${armA}\` 命中率高于对照臂 \`${armB}\`」这个单尾假设——` +
    '方向来自声明里写死的 `treatmentArm`，不按数据自动选边；看不清方向时以原始计数为准，不要只看 p 值。', '',
    `| 观察 | ${armA}（实验） | ${armB}（对照） | p（单尾，检验实验臂命中率更高） | 说明 |`,
    '|---|---|---|---|---|')

  for (const o of decl.observations) {
    // 命中＝符合声明的预期，不是「判定器返回 true」。o.expect === false 的观察，
    // 判定结果为 false 才是命中——直接用 === true 会把「预期不发生」的观察算反。
    const hit = (arm: string) => records.filter(r => r.arm === arm && r.observations[o.id] === o.expect).length
    // I7：'na'/'error' 都不计入分母（都不是「求出了一个布尔值」）。
    const valid = (arm: string) => records.filter(r => r.arm === arm && r.observations[o.id] !== 'na' && r.observations[o.id] !== 'error').length
    const [ha, hb, na, nb] = [hit(armA), hit(armB), valid(armA), valid(armB)]
    // I6：任一臂有效样本数为 0 时，Fisher 会退化印出 p=1.0000——这看起来像「差异不显著」，
    // 但真实原因是分母恒为 0（如对照臂根本没有验证机制，某条观察在它身上必然为 null）。
    // 印成一个显式的破折号，别让读报告的人把「没法算」误读成「算过了，没差异」。
    const pCell = na === 0 || nb === 0 ? '—（对照臂无有效样本）' : fisherOneTailed(ha, na - ha, hb, nb - hb).toFixed(4)
    L.push(`| \`${o.id}\` | **${ha}/${na}** | **${hb}/${nb}** | ${pCell} | ${o.desc} |`)
  }

  // 按 observation id 分组列出 na/error 次数——一个笼统的总数会让「10 次全 0/0」的一条
  // 观察和「多条各出现几次」混在一起看不出来，得让人一眼看出是哪条观察在丢数据。
  // I7：两种原因分两行印，别再混成一句「本次跑不适用，或判定器不存在/抛异常」——
  // 后者意味着声明文件里的 predicate 名拼错或判定器本身有 bug，是需要人工核查的红色信号，
  // 前者只是「这条观察对这次跑没有信息量」，混在一起会让「尺子滑了」在报告里隐形。
  const naByObs = new Map<string, number>()
  const errorByObs = new Map<string, number>()
  for (const r of records) {
    for (const [obsId, v] of Object.entries(r.observations)) {
      if (v === 'na') naByObs.set(obsId, (naByObs.get(obsId) ?? 0) + 1)
      else if (v === 'error') errorByObs.set(obsId, (errorByObs.get(obsId) ?? 0) + 1)
    }
  }
  if (naByObs.size > 0) {
    L.push('', '⚠️ 以下观察存在「本次跑不适用」（na）的记录，已排除在分母之外：')
    for (const [obsId, count] of naByObs) {
      L.push(`- \`${obsId}\`：${count} 次`)
    }
  }
  if (errorByObs.size > 0) {
    L.push('', '🔴 以下观察存在「判定器不存在或抛异常」（error）的记录，已排除在分母之外——' +
      '这通常意味着声明文件里的 predicate 名拼错、或判定器本身有 bug，需要人工核查：')
    for (const [obsId, count] of errorByObs) {
      L.push(`- \`${obsId}\`：${count} 次`)
    }
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
    `3. **k=${decl.k} 的功效有限。** 中等效应（如 5/5 vs 3/5，p≈0.22（单尾））判不出来——遇到这种结果，正确的结论是「效应弱或需要更大 k」，不是「无效」。`,
    '')

  return L.join('\n')
}
