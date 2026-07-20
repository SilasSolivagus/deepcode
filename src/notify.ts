import fs from 'node:fs'

const BEL = '\x07'

export type NotifChannel =
  | 'auto' | 'iterm2' | 'iterm2_with_bell' | 'terminal_bell'
  | 'kitty' | 'ghostty' | 'notifications_disabled'

// 终端通知渠道枚举
export const NOTIF_CHANNELS: NotifChannel[] = [
  'auto', 'iterm2', 'iterm2_with_bell', 'terminal_bell', 'kitty', 'ghostty', 'notifications_disabled',
]

export function resolveNotifChannel(pref: string | undefined): NotifChannel {
  return (NOTIF_CHANNELS as string[]).includes(pref ?? '') ? (pref as NotifChannel) : 'auto'
}

/** auto：按 TERM_PROGRAM 探测（ghostty→777 / kitty→99 / 其余→OSC9）+ BEL 兜底。 */
function autoSequence(message: string, term?: string): string {
  const t = (term ?? '').toLowerCase()
  let osc: string
  if (t.includes('ghostty')) osc = `\x1b]777;notify;deepcode;${message}${BEL}`
  else if (t.includes('kitty')) osc = `\x1b]99;;${message}${BEL}`
  else osc = `\x1b]9;${message}${BEL}`
  return osc + BEL
}

/** 按渠道构造终端转义序列。disabled → null。 */
export function notifSequence(message: string, channel: NotifChannel, term = process.env.TERM_PROGRAM): string | null {
  switch (channel) {
    case 'notifications_disabled': return null
    case 'terminal_bell': return BEL
    case 'iterm2': return `\x1b]9;${message}${BEL}`
    case 'iterm2_with_bell': return `\x1b]9;${message}${BEL}${BEL}`
    case 'kitty': return `\x1b]99;;${message}${BEL}`
    case 'ghostty': return `\x1b]777;notify;deepcode;${message}${BEL}`
    case 'auto': default: return autoSequence(message, term)
  }
}

/** 直写 /dev/tty（绕过 ink 全屏 stdout）；失败退化 process.stdout。disabled→no-op。 */
export function emitNotification(message: string, channel: NotifChannel, term = process.env.TERM_PROGRAM): void {
  const msg = message.slice(0, 200).replace(/\n/g, ' ')
  const seq = notifSequence(msg, channel, term)
  if (seq === null) return
  try { fs.writeFileSync('/dev/tty', seq) }
  catch { try { process.stdout.write(seq) } catch { /* 尽力而为 */ } }
}

export interface IdleNotifier { arm(): void; cancel(): void }

/** 空闲通知定时器（可测）：arm 起计时，到点若仍空闲且无活跃 loop 任务则 emit。
 *  arm 前先 cancel 旧定时器（不叠加）。阈值到点 + 无活跃 loop 任务时才触发。 */
export function makeIdleNotifier(deps: {
  thresholdMs: number
  isIdle: () => boolean
  hasActiveLoop: () => boolean
  emit: () => void
  setTimer?: (fn: () => void, ms: number) => any
  clearTimer?: (h: any) => void
}): IdleNotifier {
  const setT = deps.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clrT = deps.clearTimer ?? ((h) => clearTimeout(h))
  let handle: any = null
  const cancel = () => { if (handle !== null) { clrT(handle); handle = null } }
  return {
    arm() {
      cancel()
      handle = setT(() => {
        handle = null
        if (deps.isIdle() && !deps.hasActiveLoop()) deps.emit()
      }, deps.thresholdMs)
    },
    cancel,
  }
}
