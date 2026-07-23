// src/tui/components/MaskedInput.tsx
// 可复用的健壮粘贴单行输入（遮罩/明文皆可）。镜像 InputBox.tsx 的粘贴合并去抖方案，
// 但不 import/改 InputBox：常量与逻辑自含，避免主输入框回归。
// 用途：首启向导等 key 录入点（Task 2 接线），单行、无光标移动/历史，YAGNI。
import React, { useState, useRef, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'

// 粘贴合并去抖窗口（ms）+ 判定为「粘贴块」的最小长度，与 InputBox 同值。
const PASTE_COALESCE_MS = 40
const PASTE_MIN_LEN = 20

export function MaskedInput(props: {
  masked: boolean
  placeholder?: string
  onSubmit: (value: string) => void
  onCancel?: () => void
}) {
  const [value, setValue] = useState('')
  const valueRef = useRef(value)
  const pasteBufRef = useRef('')
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setVal = (v: string) => { valueRef.current = v; setValue(v) }

  // 剥 bracketed-paste 标记 + 控制字符（保留可见字符）。直接态与 flush 共用：
  // 短粘贴（< PASTE_MIN_LEN 且不含换行）不会进入 buffer，但终端仍可能附带 \x1b[200~/\x1b[201~。
  // \x1b 可选：ink useInput 对整段 input 只切掉「第一个」前导 \x1b（其 TODO 注释承认的既有行为），
  // 若粘贴恰好是 input 的第一个字符，标记开头的 \x1b 会被 ink 吃掉，只剩裸 "[200~"；实测校准确认。
  const sanitize = (s: string) => s
    .replace(/\x1b?\[20[01]~/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

  const flush = () => {
    if (pasteTimerRef.current) { clearTimeout(pasteTimerRef.current); pasteTimerRef.current = null }
    const raw = pasteBufRef.current
    pasteBufRef.current = ''
    if (!raw) return
    const firstLine = sanitize(raw).split(/\r|\n/)[0]
    setVal(valueRef.current + firstLine)
  }

  // 卸载时清掉悬挂的去抖定时器（避免卸载后 setState）
  useEffect(() => () => { if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current) }, [])

  useInput((input, key) => {
    if (key.escape) { props.onCancel?.(); return }
    if (key.return) {
      if (pasteTimerRef.current) return   // 粘贴在途：等 flush，不提交
      props.onSubmit(valueRef.current.trim())
      return
    }
    if (key.backspace || key.delete) { setVal(valueRef.current.slice(0, -1)); return }
    if (key.ctrl || key.meta || key.tab) return
    if (input) {
      const pasteLike = pasteTimerRef.current !== null || /[\r\n]/.test(input) || input.length > PASTE_MIN_LEN
      if (pasteLike) {
        pasteBufRef.current += input
        if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current)
        pasteTimerRef.current = setTimeout(flush, PASTE_COALESCE_MS)
        return
      }
      const clean = sanitize(input)
      if (clean) setVal(valueRef.current + clean)
    }
  })

  const shown = props.masked ? '•'.repeat(value.length) : value

  return (
    <Box>
      {value === '' && props.placeholder
        ? <Text><Text inverse> </Text><Text dimColor>{props.placeholder}</Text></Text>
        // key 按「空/非空」二值切换（而非随每次按键变化）：ink 5.2.1 在 ink-testing-library 下对
        // 「同一 Text 节点内容从空串直接跳到多字符串」的首次 update 有渲染 bug（只吐出 1 个字符，
        // 实测反复验证），逐字符递增 update 不受影响；用 key 只在「空→非空」这一次跳变强制重挂载，
        // 规避 bug 且不影响后续正常输入性能。
        : <Text key={value === '' ? 'empty' : 'value'}>{shown}<Text inverse> </Text></Text>}
    </Box>
  )
}
