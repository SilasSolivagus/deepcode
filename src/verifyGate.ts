// src/verifyGate.ts
//
// 收工前的验证自检门。挂在 runLoop 的「模型无工具调用、即将 return 'done'」那一点上
// （与 /goal 的 goalGate 同一个接缝）。
//
// 为什么需要它：验证合同此前**只写在系统提示里**，是纯粹的说服。真机实测（2026-08-04）
// 在跑完的三次里被违反了一次——机制侧毫无问题（合同注入成功、Agent 工具可用、轮次还剩一半），
// 模型改了 19 个文件、直接收工、在交付陈述里自评「## Verifying … 82/82 tests pass」。
// 提示词加重措辞是同一个杠杆的更多剂量；这个门是另一个杠杆：在它真的要走的那一刻拦一下。
//
// ⚠️ 刻意做成「有上限的催促」而不是「硬拦不让收工」：合同自己允许在没拿到 PASS 时收工，
// 只要明说「未通过验证」（原文：「若预算耗尽或始终没拿到 PASS，必须把验证者的原始 findings
// 带出来、明说『未通过验证』，不得自评完成」）。硬拦会与合同自相矛盾，且模型如果就是不派，
// 门会把剩余轮次全烧光——比放它走更糟。

/** 催促文案。措辞要点：①点名它已经改了多少文件、够触发条件；②给两条都合法的出路
 *  （派验证者，或明说未验证），不留「继续自评」这条路；③不重复整段合同——那已经在系统提示里，
 *  再抄一遍只会挤占上下文。 */
export function verifyNudge(edits: number): string {
  return `你本次已改动 ${edits} 个文件，达到验证合同的触发条件，但全程没有派出 subagent_type="verification" 的子代理。`
    + `现在二选一：（a）派一个验证子代理，把原始任务、改过的文件、你采用的方法传给它，拿到它的 verdict；`
    + `（b）确实不打算验，那就在最终回答里明确写出「未通过验证」并说明原因。`
    + `不要用「我跑了测试都通过」来代替——判定权归验证者独占，你的自查不能替代它的 verdict。`
}

/** 从对话里数出「改过多少个不同文件」与「有没有派过验证子代理」。
 *  纯函数，不依赖运行时状态——好测，也好在别处复用。 */
export function scanForVerification(messages: any[]): { editedFiles: number; spawnedVerifier: boolean } {
  const files = new Set<string>()
  let spawnedVerifier = false
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls) {
      const name = tc?.function?.name
      if (!name) continue
      let args: any
      try { args = JSON.parse(tc.function.arguments ?? '{}') } catch { continue } // 坏 JSON 跳过，不整体失败
      if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
        // 三个写工具的路径参数名一致（file_path），与 bench/ab/artifacts.ts 的抽取口径保持同一个。
        if (typeof args.file_path === 'string') files.add(args.file_path)
      } else if (name === 'Agent' && args.subagent_type === 'verification') {
        spawnedVerifier = true
      }
    }
  }
  return { editedFiles: files.size, spawnedVerifier }
}

export interface VerifyGateOpts {
  /** 触发阈值：改动文件数达到这个数才催。默认 3，与合同文本「改动涉及 3 个以上文件」及
   *  A/B 观察 spawnedWhenEditsAtLeast 的 minEdits 对齐。
   *  ⚠️ 合同原文「3 个以上」在中文里可读作 >3 也可读作 ≥3；这里取 ≥3，与观察口径一致，
   *  两处要改一起改，否则「门催了但观察不算数」或反过来。 */
  minEdits?: number
  /** 最多催几次。默认 2。不设上限的话，模型若铁了心不派，门会把剩余轮次全烧光。 */
  maxNudges?: number
}

/** 造一个收工前自检门。返回值形状与 goalGate 一致，直接接进 runLoop 的 deps。
 *  闭包持有催促计数——每次 runLoop 调用都新建一个，不跨会话累积。 */
export function makeVerifyGate(opts: VerifyGateOpts = {}) {
  const minEdits = opts.minEdits ?? 3
  const maxNudges = opts.maxNudges ?? 2
  let nudges = 0
  return async (messages: any[]): Promise<{ continue: true; inject: string } | { continue: false }> => {
    if (nudges >= maxNudges) return { continue: false } // 催过了还不派，放它走（见文件头的取舍说明）
    const { editedFiles, spawnedVerifier } = scanForVerification(messages)
    if (spawnedVerifier || editedFiles < minEdits) return { continue: false }
    nudges++
    return { continue: true, inject: verifyNudge(editedFiles) }
  }
}
