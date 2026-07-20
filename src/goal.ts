import type OpenAI from 'openai'
import { chatStream } from './api.js'

export interface ActiveGoal { condition: string; iterations: number; setAt: number; lastReason?: string }
export interface GoalVerdict { ok: boolean; reason?: string; impossible?: boolean }

export const MAX_GOAL_CONDITION_CHARS = 4000
export const MAX_GOAL_ITERATIONS = 25
export const GOAL_JUDGE_TIMEOUT_MS = 30000
export const GOAL_CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])

export function goalDirective(condition: string): string {
  return `会话级 Stop 目标已激活，条件：“${condition}”。简短确认目标后立即开始（或继续）朝它推进——把条件本身当作你的指令，不要停下来问用户该做什么。在条件成立前，停止会被拦截。条件达成后自动清除——成功后不要叫用户运行 \`/goal clear\`，那只用于提前清除目标。`
}

export const GOAL_JUDGE_SYSTEM = `你在评估 deepcode 里的一个「停止条件」钩子。仔细阅读上面的对话记录，判断用户给出的条件是否已满足。

你的回复必须是一个 JSON 对象，形如以下之一：
- {"ok": true, "reason": "<引用记录中满足条件的证据>"}
- {"ok": false, "reason": "<引用缺什么、或什么在阻碍条件>"}
- {"ok": false, "impossible": true, "reason": "<说明为何该条件永远无法满足>"}

始终包含 "reason" 字段，尽可能逐字引用记录中的具体文本。若记录中没有清楚证据表明条件已满足，返回 {"ok": false, "reason": "insufficient evidence in transcript"}。

仅当条件在本会话中确实无法达成时才用 {"ok": false, "impossible": true}——例如：条件自相矛盾、依赖不可用的资源或能力、或助手已明确尝试并穷尽合理方法后声明做不到。自行判断：助手自称做不到只是证据、非定论，须独立确认条件确实无法达成，而非听信助手的自我评估。不要仅因目标尚未达成或进展缓慢就判不可能。拿不准时，返回 {"ok": false}，不带 "impossible"。`

export function goalJudgeUser(condition: string): string {
  return `根据以上对话记录，以下停止条件是否已满足？仅依据记录证据回答。\n\n条件：${condition}`
}

/** fail-safe：合法 JSON 且含 boolean ok → GoalVerdict；malformed/缺 ok/非 JSON → null（gate 视为放行）。 */
export function parseGoalVerdict(text: string): GoalVerdict | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    if (typeof o.ok !== 'boolean') return null
    return { ok: o.ok, reason: typeof o.reason === 'string' ? o.reason : undefined, impossible: o.impossible === true }
  } catch { return null }
}

/** fast 档单发 judge 评判条件。异常/超时/malformed → 'error'（gate 放行停止）。 */
export async function runGoalJudge(
  client: OpenAI, messages: any[], condition: string, fastModel: string, signal: AbortSignal,
): Promise<GoalVerdict | 'error'> {
  const convo = messages.filter(m => m.role !== 'system')
  const ac = new AbortController()
  if (signal.aborted) ac.abort()
  const onAbort = () => ac.abort()
  signal.addEventListener('abort', onAbort)
  const timer = setTimeout(() => ac.abort(), GOAL_JUDGE_TIMEOUT_MS)
  try {
    const gen = chatStream(client, {
      model: fastModel,
      messages: [{ role: 'system', content: GOAL_JUDGE_SYSTEM }, ...convo, { role: 'user', content: goalJudgeUser(condition) }],
      tools: [],
      thinking: false,
      signal: ac.signal,
    })
    let step
    while (!(step = await gen.next()).done) { /* drain */ }
    return parseGoalVerdict(step.value.content ?? '') ?? 'error'
  } catch {
    return 'error'
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort)
  }
}
