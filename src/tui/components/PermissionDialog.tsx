// src/tui/components/PermissionDialog.tsx
// 权限确认弹窗：accent 边框面板，diff 预览，高危警告，1/2/3 编号菜单（↑↓+Enter 方向键 / 数字键 / y/n/a 快捷键）。
import React, { useEffect, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme.js'
import { useSelection } from '../useSelection.js'
import { buildPreview } from '../diffPreview.js'
import type { PendingAsk } from '../useChat.js'
import { type Decision, permissionSourceName } from '../../permissions.js'

/** 弹窗上屏后丢弃决策键的时长（ms）。
 *  队列化之后两个权限弹窗会真正背靠背出现在同一批里，用户为上一个按下的 Enter
 *  若晚一拍落地就打在刚上屏的下一个弹窗上，而它的默认选中项是「允许」——
 *  权限层的默认值在放行方向，误触必须按放行成本来防。150ms 低于人对新弹窗的反应时间，
 *  不影响单个弹窗的常规操作；期间方向键仍可用，只是不接受「决策」。 */
export const INPUT_GUARD_MS = 150

export function PermissionDialog(props: {
  ask: PendingAsk
  onDecide: (d: Decision) => void
  /** 队列里待确认的总数（含当前这个）。>1 时提示还有几个。 */
  queued?: number
}) {
  const T = useTheme()
  const { ask, onDecide, queued } = props
  const preview = buildPreview(ask.toolName, ask.desc)

  // 子代理来源的确认走 buildSubagentPermission，那里的 saveRule 是 no-op（子代理不得持久化规则），
  // 所以 always 实际只等于放行本次、下次同类操作照样问。若照抄「本会话不再询问」，
  // 权限界面就是在对用户陈述假的后果，训练出「点了也没用，闭眼点」的习惯——
  // 恰好抵消掉向上转发想拿回的那道人工闸门。选项保留（去掉会打乱 1/2/3 与 a 的键位映射），只把文案说实话。
  const alwaysLabel = ask.origin
    ? '允许本次（子代理规则不落盘，下次仍会问）'
    : ask.previewRule ? `总是允许 — ${ask.previewRule}` : '总是允许（本会话不再询问）'
  const options: Array<{ label: string; decision: Decision }> = [
    { label: '允许', decision: 'yes' },
    { label: alwaysLabel, decision: 'always' },
    { label: '拒绝', decision: 'no' },
  ]
  const sel = useSelection(options.length)
  const idx = sel.idx

  // 上屏时刻起算的输入去抖窗口。App/FullscreenApp 给了 key=ask.id，换队首即重新挂载，
  // 初值天然就是本 ask 的上屏时刻；这里再按 ask 重挂一次是为了不把正确性押在调用方给了 key 上。
  const guardUntil = useRef(Date.now() + INPUT_GUARD_MS)

  // 同上：有 key 时换项即重挂，这条 effect 跑不到；留着是兜底——
  // 万一将来某个接线点忘了给 key，选中位置与去抖窗口至少还会随 ask 重置，
  // 而不是把上一个弹窗选到的"总是允许"连同一次快速 Enter 直接误授给下一个工具。
  useEffect(() => { sel.set(0); guardUntil.current = Date.now() + INPUT_GUARD_MS }, [ask])

  useInput((input, key) => {
    // 方向键先放行：去抖只挡「决策」，不挡挪光标，用户可以在窗口期内就把选择挪到位。
    if (key.upArrow) { sel.prev(); return }
    if (key.downArrow) { sel.next(); return }
    if (Date.now() < guardUntil.current) return
    if (key.return) { onDecide(options[sel.current()].decision); return }
    if (key.shift && key.tab) { onDecide('always'); return }
    if (key.escape) { onDecide('no'); return }
    const k = input.toLowerCase()
    if (k === 'y' || k === '1') { onDecide('yes'); return }
    if (k === 'a' || k === '2') { onDecide('always'); return }
    if (k === 'n' || k === '3') { onDecide('no'); return }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent} paddingX={1}>
      <Text bold color={T.accent}>{preview.title}</Text>
      {ask.dangerous && (
        <Text color={T.err}>⚠ 高危操作；always 也只精确放行这一条</Text>
      )}
      {ask.reason?.type === 'rule' && ask.reason.rule.behavior === 'deny' && (
        <Text color={T.err}>⚠ 命中 deny 规则 {ask.reason.rule.value}（来自 {permissionSourceName(ask.reason.rule.source)}）</Text>
      )}
      {ask.reason?.type === 'hook' && (
        <Text dimColor>权限被 hook {ask.reason.hookName} 拒绝</Text>
      )}
      {ask.origin && (
        <Text color={T.dim}>来自子代理 {ask.origin.agentType}（{ask.origin.agentId}）</Text>
      )}
      {queued !== undefined && queued > 1 && (
        <Text color={T.dim}>还有 {queued - 1} 个待确认</Text>
      )}
      {preview.lines.map((line, i) => (
        <Text key={i} color={line.sign === '+' ? T.ok : line.sign === '-' ? T.err : T.dim}>
          {line.sign === '+' ? '+ ' : line.sign === '-' ? '- ' : '  '}
          {line.text}
        </Text>
      ))}
      {preview.truncated && (
        <Text dimColor>… (仅显示前 40 行)</Text>
      )}
      <Text>要执行这个操作吗？</Text>
      {options.map((opt, i) => (
        <Text key={opt.decision} color={i === idx ? T.accent : undefined} dimColor={i !== idx}>
          {i === idx ? '❯ ' : '  '}
          {i + 1}. {opt.label}
        </Text>
      ))}
      <Text dimColor>↑↓/数字 选择 · Enter 确认 · Shift+Tab 允许并本会话不再问 · Esc 拒绝</Text>
    </Box>
  )
}
