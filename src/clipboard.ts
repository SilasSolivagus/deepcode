import { spawnSync } from 'node:child_process'

/** 从后往前找第一条 role=assistant 且 content 为非空字符串的消息，返回其文本；找不到返回 null。纯函数、零副作用。 */
export function lastAssistantText(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    if (typeof m.content !== 'string') continue
    if (m.content.trim() === '') continue
    return m.content
  }
  return null
}

/** 从最新往回数第 n 条（n≥1，n=1 即最新）role=assistant 非空文本消息。找不到返回 null。纯函数。 */
export function nthAssistantText(messages: any[], n: number): string | null {
  if (!Number.isInteger(n) || n < 1) return null
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    if (typeof m.content !== 'string') continue
    if (m.content.trim() === '') continue
    if (++count === n) return m.content
  }
  return null
}

/** 取文本里最后一个 ``` 围栏代码块的内容（去掉围栏与尾换行）。无代码块返回 null。纯函数。 */
export function lastCodeBlock(text: string | null): string | null {
  if (!text) return null
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
  if (blocks.length === 0) return null
  return blocks[blocks.length - 1][1].replace(/\n$/, '')
}

/** OSC52 终端剪贴板转义序列：让终端自身把 text 写入系统剪贴板（跨平台 + 穿透 SSH）。纯函数。 */
export function osc52Sequence(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return `\x1b]52;c;${b64}\x07`
}

/**
 * 把 text 写入系统剪贴板：macOS 优先 pbcopy（可靠、无长度限制），失败或非 macOS
 * 回退 OSC52 写终端（跨平台 + 穿透 SSH，需终端允许）。始终尽力而为，不抛错。
 */
export function copyToClipboard(text: string): void {
  if (process.platform === 'darwin') {
    const r = spawnSync('pbcopy', { input: text })
    if (!r.error && r.status === 0) return
    // pbcopy 不可用 → 回退 OSC52
  }
  process.stdout.write(osc52Sequence(text))
}
