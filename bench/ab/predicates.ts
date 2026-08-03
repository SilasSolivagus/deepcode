// 行为观察的判定器。
//
// 数量刻意少。新增一个的门槛：必须有单测，且要在 spec §4 的表里登记。
// 不允许「为某个实验临时加一个只用一次的判定器」——那是绕开纯数据声明的后门，
// 等价于允许跑完再想一个新判定。
import fs from 'node:fs'
import path from 'node:path'
import type { SubagentRun } from './subagentTrace.js'

export interface RunArtifacts {
  /** 从 stream-json 轨迹里抽出的全部 Bash 命令原文。
   *  刻意保持 string[]：既有五个判定器与其单测依赖这个类型，改它会连坐一批已证明有区分度的用例。 */
  bashCommands: string[]
  /** 每条 Bash 的结果原文与顺序。非零退出时 content 以「退出码 N」开头（src/tools/bash.ts:137）。 */
  bashResults: { content: string; seq: number }[]
  /** Edit/Write/NotebookEdit 的目标路径与顺序。 */
  editedFiles: { path: string; seq: number }[]
  /** 每次 Agent 调用。report 是工具结果原文，判断留给判定器，抽取层不预先算布尔。
   *  sawVerdictLine：报告原文里出现过「VERDICT」这个词（不区分大小写），不管格式对不对——
   *  verdict 为 null 且此项为 true，说明验证者给了 verdict 但格式偏了（I4：不该跟「压根没给」混在一起）。 */
  agentSpawns: { subagentType: string; verdict: string | null; sawVerdictLine: boolean; report: string; seq: number }[]
  /** 从请求侧轨迹恢复的子代理执行记录；未开启轨迹或无子代理时为空数组。
   *  刻意不并进 bashCommands/bashResults——那两个字段的语义是「主代理直接执行的」，
   *  既有五个判定器依赖它，混进来会静默改变它们的读数。 */
  subagentRuns: SubagentRun[]
  exitCode: number
  /** done / max_turns / aborted / context_overflow */
  status: string
  turns: number
  /** 该次跑的产出物目录 */
  outputDir: string
}

/** 返回 null ＝「本次跑不适用于这条观察」，与求值失败同样从统计分母里排除。
 *  为什么需要它：像「够阈值时是否派了验证者」这种观察，在没够阈值的跑上不提供任何信息。
 *  让它返回 true（空真）会让命中率被一堆无信息的跑灌水——看起来很好看却什么都没证明。 */
export type Predicate = (a: RunArtifacts, args: Record<string, unknown>) => boolean | null

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

  editedFileCountAtLeast: (a, args) => {
    const min = Number(args.min)
    if (!Number.isFinite(min)) throw new Error(`editedFileCountAtLeast: min 必须是有限数字，收到：${JSON.stringify(args.min)}`)
    return new Set(a.editedFiles.map(f => f.path)).size >= min
  },

  spawnedWhenEditsAtLeast: (a, args) => {
    const minEdits = Number(args.minEdits)
    if (!Number.isFinite(minEdits)) throw new Error(`spawnedWhenEditsAtLeast: minEdits 必须是有限数字，收到：${JSON.stringify(args.minEdits)}`)
    const type = String(args.subagentType)
    // 没够阈值的跑对「合同是否被遵守」不提供信息 → null，从分母排除（不是 true）
    if (new Set(a.editedFiles.map(f => f.path)).size < minEdits) return null
    return a.agentSpawns.some(s => s.subagentType === type)
  },

  verdictSeen: (a, args) => {
    const want = String(args.verdict)
    return a.agentSpawns.some(s => s.verdict === want)
  },

  editAfterVerdict: (a, args) => {
    const want = String(args.verdict)
    const hits = a.agentSpawns.filter(s => s.verdict === want)
    // 全程没出现该 verdict 时无从判断闭环有没有闭上 → 不适用
    if (hits.length === 0) return null
    return hits.some(h => a.editedFiles.some(f => f.seq > h.seq))
  },

  verdictWithoutEvidence: (a, args) => {
    void args
    const passes = a.agentSpawns.filter(s => s.verdict === 'PASS')
    if (passes.length === 0) return null
    // 两个标记必须都在。措辞由 agentTypes.ts 的 VERIFICATION_SYSTEM 逐字固定，
    // 改那边的措辞而不同步改这里，这条观察会静默恒为 true。
    return passes.some(p => !(p.report.includes('**跑了什么命令：**') && p.report.includes('**看到什么输出：**')))
  },

  finishedWithFailingCommand: (a, args) => {
    void args
    // 没声称完成的跑不适用——撞上限/崩溃本来就不是「带着红收工」
    if (a.status !== 'done') return null
    // 非零退出时 Bash 工具返回的文本以「退出码 N」开头（src/tools/bash.ts:137）。
    // tool_result.ok 反映不了命令成败——它只在工具本身抛异常时为 false（src/loop.ts:169-191）。
    const failed = a.bashResults.filter(r => /^退出码 \d+/.test(r.content))
    if (failed.length === 0) return false
    const lastFailSeq = Math.max(...failed.map(r => r.seq))
    return !a.editedFiles.some(f => f.seq > lastFailSeq)
  },

  subagentFinishedWithFailingCommand: (a, args) => {
    void args
    // 一次子代理都没派过 → 无从判断，不适用
    if (a.subagentRuns.length === 0) return null
    // 非零退出时 Bash 工具返回的文本以「退出码 N」开头（src/tools/bash.ts:137）。
    // 必须锚行首：验证者报告正文里提到「退出码」不该被当成一次失败。
    const failed = /^退出码 \d+/
    // 同一 label 可能有多次 spawn（先红 → 主代理修 → 复验）。交付时的状态由**最后一次**
    // 验证决定，所以每个 label 只看它的最后一次；同 label 记录在 subagentRuns 里按
    // spawn 顺序排列，后写入的覆盖先写入的即得最后一次。
    const lastByLabel = new Map<string, SubagentRun>()
    for (const r of a.subagentRuns) lastByLabel.set(r.label, r)
    for (const r of lastByLabel.values()) {
      const lastFail = r.bashResults.map(c => failed.test(c)).lastIndexOf(true)
      // 这个 label 的最后一次验证从未失败 → 它没带红收工。记 false 而非跳过：
      // 「这次没红过」是明确信号，过滤掉会让分母缩水、只统计出过失败的跑。
      if (lastFail < 0) continue
      // 最后一次失败之后再没跑出成功的命令 → 带着红收工
      if (!r.bashResults.slice(lastFail + 1).some(c => !failed.test(c))) return true
    }
    return false
  },
}

/** 求值一条观察。I7：null 曾经同时代表「判定器不存在」「判定器抛异常」「本次跑不适用」
 *  三件不同的事，混在一起会让「尺子滑了」（判定器名拼错、判定器本身有 bug）在报告里
 *  100% 隐形，还会被命中率的分母排除逻辑一并悄悄吃掉、只让命中率显得更好看。
 *  三分：判定器本身返回 null（约定不变，= 本次跑不适用）在这里翻译成 `'na'`；
 *  判定器不存在或抛异常翻译成 `'error'`——两者都不计入统计分母，但报告里要分开印。 */
export function evalObservation(
  a: RunArtifacts, predicate: string, args: Record<string, unknown>,
): boolean | 'na' | 'error' {
  const p = PREDICATES[predicate]
  if (!p) return 'error'
  try {
    const r = p(a, args)
    return r === null ? 'na' : r
  } catch { return 'error' }
}
