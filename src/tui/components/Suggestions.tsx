// src/tui/components/Suggestions.tsx
// 斜杠命令 + @文件 浮动补全菜单：↑↓ 移动，Tab/Enter 确认补全。
// 技能描述菜单简写（第一句）+ 最多 2 行动态截断 + 行预算视口 + 前景高亮两栏对齐。
import React, { useState, useEffect } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import stringWidth from 'string-width'
import { useTheme, GUTTER } from '../theme.js'
import { layoutDescription, computeLineWindow, type Suggestion } from '../suggest.js'

const NAME_CAP = 24 // 命令名列宽上限
const GAP = 2       // 名列与描述列的间隔

export function Suggestions(props: {
  items: Suggestion[]
  onPick: (value: string) => void
}) {
  const T = useTheme()
  const { stdout } = useStdout()
  const { items, onPick } = props
  const [idx, setIdx] = useState(0)

  useEffect(() => { setIdx(0) }, [items])

  useInput((input, key) => {
    if (!items.length) return
    if (key.downArrow) { setIdx(i => Math.min(i + 1, items.length - 1)); return }
    if (key.upArrow) { setIdx(i => Math.max(i - 1, 0)); return }
    // Shift+Tab 归权限模式循环（App/FullscreenApp），不可当成确认补全
    if ((key.tab && !key.shift) || key.return) { if (items[idx]) onPick(items[idx].value); return }
  })

  if (!items.length) return null

  const rows = stdout?.rows ?? 24
  const columns = stdout?.columns ?? 80
  // 名列宽 = min(上限, 最长名显示宽, 列数×40%)——有描述时名列封 40%。
  // 无描述项（如 @ 文件补全）：名列吃满，不套 24/40% 上限（否则长路径被截）。有描述才封列宽。
  const hasDesc = items.some(i => i.hint !== '')
  const nameW = hasDesc
    ? Math.min(NAME_CAP, Math.max(...items.map(i => stringWidth(i.value))), Math.max(1, Math.floor(columns * 0.4)))
    : Math.max(...items.map(i => stringWidth(i.value)))
  const indent = nameW + GAP
  // 描述可用宽度 = 列数 − 两侧 padding − 名列缩进 − 4（固定安全余量，防偶发挤到第二行）。
  const avail = Math.max(0, columns - GUTTER * 2 - indent - 4)

  // 每项预排版：hint 已在 computeSuggestions 按来源做过首句简写，这里只按 avail 排成 1~2 行。
  const laid = items.map(it => {
    const { line1, line2 } = it.hint === ''
      ? { line1: '', line2: '' }
      : layoutDescription(it.hint, avail, avail)
    return { value: it.value, line1, line2, height: line2 ? 2 : 1 }
  })

  // 行预算视口：以行数（非条数）开窗，保证菜单总高 ≤ 预算、输入框不被挤出屏。
  const lineBudget = Math.max(1, Math.min(Math.max(6, Math.floor(rows / 2)), rows - 3))
  const { start, end } = computeLineWindow(laid.map(x => x.height), idx, lineBudget)

  return (
    <Box flexDirection="column" paddingX={GUTTER}>
      {laid.slice(start, end).map((item, i) => {
        const selected = start + i === idx
        // 无描述（文件补全）：整值单栏，截断到终端宽度而非名列宽，长路径全显。
        if (!hasDesc) {
          return (
            <Box key={item.value}>
              <Text color={selected ? T.accent : undefined} dimColor={!selected} wrap="truncate">
                {item.value}
              </Text>
            </Box>
          )
        }
        return (
          <Box key={item.value} flexDirection="column">
            <Box>
              <Box width={indent} flexShrink={0}>
                <Text color={selected ? T.accent : undefined} dimColor={!selected} wrap="truncate">
                  {item.value}
                </Text>
              </Box>
              {item.line1 !== '' && <Text dimColor wrap="truncate">{item.line1}</Text>}
            </Box>
            {item.line2 !== '' && (
              // 第 2 行缩进到描述列，续行首字对齐第 1 行描述。
              <Box>
                <Box width={indent} flexShrink={0}><Text> </Text></Box>
                <Text dimColor wrap="truncate">{item.line2}</Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
