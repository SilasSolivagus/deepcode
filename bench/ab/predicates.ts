// 行为观察的判定器。
//
// 数量刻意少。新增一个的门槛：必须有单测，且要在 spec §4 的表里登记。
// 不允许「为某个实验临时加一个只用一次的判定器」——那是绕开纯数据声明的后门，
// 等价于允许跑完再想一个新判定。
import fs from 'node:fs'
import path from 'node:path'

export interface RunArtifacts {
  /** 从 stream-json 轨迹里抽出的全部 Bash 命令原文。
   *  刻意保持 string[]：既有五个判定器与其单测依赖这个类型，改它会连坐一批已证明有区分度的用例。 */
  bashCommands: string[]
  /** 每条 Bash 的结果原文与顺序。非零退出时 content 以「退出码 N」开头（src/tools/bash.ts:137）。 */
  bashResults: { content: string; seq: number }[]
  /** Edit/Write/NotebookEdit 的目标路径与顺序。 */
  editedFiles: { path: string; seq: number }[]
  /** 每次 Agent 调用。report 是工具结果原文，判断留给判定器，抽取层不预先算布尔。 */
  agentSpawns: { subagentType: string; verdict: string | null; report: string; seq: number }[]
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
    const min = Number(args.min)
    if (!Number.isFinite(min)) throw new Error(`numericFromBashAtLeast: min 必须是有限数字，收到：${JSON.stringify(args.min)}`)

    const pattern = String(args.pattern)
    let max = -Infinity
    for (const c of a.bashCommands) {
      // 创建新的 RegExp 且带 g 标志，以便在同一条命令内遍历全部匹配。
      // 每条命令重新创建正则（而非复用带 lastIndex 的实例），避免状态污染。
      const re = new RegExp(pattern, 'g')
      let m
      while ((m = re.exec(c)) !== null) {
        if (m[1] !== undefined) max = Math.max(max, Number(m[1]))
      }
    }
    // 一处都没抽到时 max 仍是 -Infinity → false。刻意不返回 true：
    // 「没做这件事」不该被算成「达标」。
    return max >= min
  },

  statusIs: (a, args) => a.status === String(args.status),

  fileExists: (a, args) => {
    const relPath = String(args.relPath)
    // 绝对路径或路径逃逸会被检查和拒绝
    if (path.isAbsolute(relPath)) {
      throw new Error(`fileExists: 不允许绝对路径，relPath "${relPath}" 是绝对路径`)
    }
    const joinedPath = path.join(a.outputDir, relPath)
    const resolved = path.resolve(joinedPath)
    const outputDirResolved = path.resolve(a.outputDir)

    // 确保解析后的路径确实落在 outputDir 之内（使用尾部分隔符边界检查）。
    if (!resolved.startsWith(outputDirResolved + path.sep) && resolved !== outputDirResolved) {
      throw new Error(`fileExists: 检测到路径逃逸，relPath "${relPath}" 逃出了 outputDir`)
    }

    return fs.existsSync(resolved)
  },
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
