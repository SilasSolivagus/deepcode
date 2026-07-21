// src/tui/components/SelectList.tsx
// 通用 ↑↓ Enter Esc 列表选择器（/resume /model /theme 等用）。
// 选中行 ❯ 指针 + accent 前景（对齐弹窗风格，不用整行反色块）；长列表按行预算开窗滚动。
import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme.js'
import { computeLineWindow } from '../suggest.js'

const WINDOW_LINES = 12

export function SelectList(p: {
  items: string[]
  onPick: (index: number) => void
  onCancel: () => void
  title?: string
}) {
  const T = useTheme()
  const [idx, setIdx] = useState(0)

  useInput((_input, key) => {
    if (key.upArrow) {
      setIdx(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setIdx(i => Math.min(p.items.length - 1, i + 1))
      return
    }
    if (key.return) {
      p.onPick(idx)
      return
    }
    if (key.escape) {
      p.onCancel()
      return
    }
  })

  // 行预算开窗：以 idx 为中心，最多 WINDOW_LINES 项，输入框不被长列表挤出屏。
  const heights = p.items.map(() => 1)
  const { start, end } = computeLineWindow(heights, idx, WINDOW_LINES)
  const win = p.items.slice(start, end)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent} paddingX={1}>
      {p.title ? <Text color={T.accent}>{p.title}</Text> : null}
      {start > 0 ? <Text dimColor>{'  ↑ 还有 '}{start}{' 项'}</Text> : null}
      {win.map((item, i) => {
        const real = start + i
        const selected = real === idx
        return (
          <Text key={real} color={selected ? T.accent : undefined} dimColor={!selected}>
            {selected ? '❯ ' : '  '}{item}
          </Text>
        )
      })}
      {end < p.items.length ? <Text dimColor>{'  ↓ 还有 '}{p.items.length - end}{' 项'}</Text> : null}
    </Box>
  )
}
