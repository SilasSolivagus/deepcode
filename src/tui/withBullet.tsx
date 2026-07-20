import React from 'react'
import { Box, Text } from 'ink'
import type { Theme } from './theme.js'

/** ⏺ 项目符号：首行带 accent 圆点，续行回到 col 0 不缩进（圆点悬出、正文整体左对齐）。 */
export function withBullet(content: string, theme: Theme): React.ReactNode {
  const lines = content.split('\n')
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          {i === 0 ? <Text color={theme.accent}>{'⏺ '}</Text> : ''}
          {line}
        </Text>
      ))}
    </Box>
  )
}
