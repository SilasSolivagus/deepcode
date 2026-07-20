// src/recap.ts
import type OpenAI from 'openai'
import { chatStream } from './api.js'

export const RECAP_PROMPT = `用户离开后回来了。用不到 40 词、1–2 句朴素中文回顾（无 markdown）。先说总体目标和当前任务，再给下一步动作。跳过根因叙述、修复细节、次要待办和跑题。`

/** 生成一行会话回顾。无有意义 turn（无 user/assistant）→ null；否则用主循环 model 单发一次，返回 trim 文本。 */
export async function generateRecap(
  client: OpenAI, messages: any[], model: string, signal: AbortSignal,
): Promise<string | null> {
  const convo = messages.filter(m => m.role !== 'system')
  if (!convo.some(m => m.role === 'user' || m.role === 'assistant')) return null
  const gen = chatStream(client, {
    model,
    messages: [...convo, { role: 'user', content: RECAP_PROMPT }],
    tools: [],
    thinking: false,
    signal,
  })
  let step
  while (!(step = await gen.next()).done) { /* 丢弃流式增量 */ }
  return (step.value.content ?? '').trim()
}
