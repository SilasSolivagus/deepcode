// src/tui/restoreTranscript.ts
// 恢复会话（--resume / --continue / /resume / /tui 切换 / provider 切换）时，把 messages 反向映射回 UI 的
// transcript——否则模型记得全部历史，界面却一片空白。
import type { TranscriptItem } from './useChat.js'

/** OpenAI content 可能是字符串或多模态块数组（原生视觉）；只取其中的文本。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
  }
  return ''
}

/**
 * messages → transcript。system 跳过；工具行不设 ok——历史里看不出当时成没成，
 * 画 ✓ 就是撒谎（ToolLine 只在 ok === false 时标错，undefined 是中性的）。
 */
export function messagesToTranscript(messages: any[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  for (const [i, m] of messages.entries()) {
    if (m?.role === 'user') {
      const text = textOf(m.content)
      if (text) out.push({ kind: 'user', text })
    } else if (m?.role === 'assistant') {
      const text = textOf(m.content)
      if (text) {
        out.push({ kind: 'assistant', segments: [{ orig: text }], pending: '', messageId: `restored-${i}`, done: true })
      }
      for (const tc of m.tool_calls ?? []) {
        out.push({
          kind: 'tool',
          id: tc.id ?? `restored-tool-${i}`,
          name: tc.function?.name ?? '工具',
          desc: tc.function?.arguments ?? '',
          running: false,
        })
      }
    }
    // role 'tool' 的结果不单独成行（工具行已由对应的 tool_calls 产生）
  }
  return out
}
