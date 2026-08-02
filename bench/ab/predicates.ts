// 行为观察的判定器。
//
// 数量刻意少。新增一个的门槛：必须有单测，且要在 spec §4 的表里登记。
// 不允许「为某个实验临时加一个只用一次的判定器」——那是绕开纯数据声明的后门，
// 等价于允许跑完再想一个新判定。
import fs from 'node:fs'
import path from 'node:path'

export interface RunArtifacts {
  /** 从 stream-json 轨迹里抽出的全部 Bash 命令原文 */
  bashCommands: string[]
  exitCode: number
  /** done / max_turns / aborted / context_overflow */
  status: string
  turns: number
  /** 该次跑的产出物目录 */
  outputDir: string
}

export type Predicate = (a: RunArtifacts, args: Record<string, unknown>) => boolean

export const PREDICATES: Record<string, Predicate> = {
  bashCommandsAnyMatch: (a, args) => {
    const re = new RegExp(String(args.pattern))
    return a.bashCommands.some(c => re.test(c))
  },

  bashCommandsNoneMatch: (a, args) => {
    const re = new RegExp(String(args.pattern))
    return !a.bashCommands.some(c => re.test(c))
  },

  numericFromBashAtLeast: (a, args) => {
    const re = new RegExp(String(args.pattern))
    const min = Number(args.min)
    let max = -Infinity
    for (const c of a.bashCommands) {
      const m = re.exec(c)
      if (m && m[1] !== undefined) max = Math.max(max, Number(m[1]))
    }
    // 一处都没抽到时 max 仍是 -Infinity → false。刻意不返回 true：
    // 「没做这件事」不该被算成「达标」。
    return max >= min
  },

  statusIs: (a, args) => a.status === String(args.status),

  fileExists: (a, args) => fs.existsSync(path.join(a.outputDir, String(args.relPath))),
}

/** 求值一条观察。判定器不存在或抛异常时返回 null——报告里单列，不计入统计分母。
 *  一个坏判定器不该毁掉整轮跑（那轮跑本身是花了钱和时间的）。 */
export function evalObservation(
  a: RunArtifacts, predicate: string, args: Record<string, unknown>,
): boolean | null {
  const p = PREDICATES[predicate]
  if (!p) return null
  try { return p(a, args) } catch { return null }
}
