import type OpenAI from 'openai'
import { renderRecentMessages } from './extractPrompt.js'
import { buildThinkingParams } from '../../api.js'
import { activeModelMeta } from '../../providers.js'

const GATE_SYS = '你判断一段对话是否包含值得长期记住的持久信息。只输出一个小写英文单词：yes 或 no，不要任何别的字。'
const GATE_INSTRUCT = `只有这些算 yes：用户本人的事实或长期偏好、用户对工作方式的纠正或明确指导、项目的关键决策或约束。
这些都算 no：日常寒暄、一次性任务的执行细节、代码/命令的具体内容、你自己的分析或总结、临时上下文。
只输出 yes 或 no（小写英文），不要输出「是」「否」或任何解释。`

/** 便宜的严格前置门控：这段对话有无值得长期记的持久信号。
 *  错误/超时 → true（fail-open，退回「子代理自己判断」，绝不因门控故障而静默丢记忆）。
 *  只有明确 yes 才放行；空/no/其它 → false（偏保守，减噪声）。 */
export async function hasDurableSignal(
  client: OpenAI, model: string, recent: any[], signal: AbortSignal,
  onUsage?: (u: any, m: string) => void,
): Promise<boolean> {
  try {
    const res = await client.chat.completions.create({
      model, max_tokens: 4,
      // thinking 模型（如 glm）默认会先吐 reasoning，4 token 全被吃掉导致 content 恒为空；禁 thinking 让 content 直出 yes/no。
      ...buildThinkingParams(activeModelMeta(model).supportsThinking, false, undefined),
      messages: [
        { role: 'system', content: GATE_SYS },
        { role: 'user', content: `${GATE_INSTRUCT}\n\n对话：\n${renderRecentMessages(recent)}` },
      ],
    } as any, { signal })
    const u = (res as any).usage
    if (u && onUsage) onUsage(u, model)
    const raw = String((res as any).choices?.[0]?.message?.content ?? '').trim()
    const t = raw.toLowerCase()
    // 先判否定（no/否/不），再判肯定（yes/是）——中文容错，防 fast 档回「是/否」被英文正则漏判成假阴性。
    // 默认 false（偏保守减噪声）；「不是」含「不」→ 正确落 no。
    if (/\bno\b/.test(t) || raw.includes('否') || raw.includes('不')) return false
    return /\byes\b/.test(t) || raw.includes('是')
  } catch {
    return true // fail-open
  }
}
