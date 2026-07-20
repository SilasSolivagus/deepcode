// src/tui/SkillsView.tsx —— /skills 四态交互编辑器（skillOverrides）。
// 四态循环 on→name-only→user-invocable-only→off；token 成本；排序/搜索；bounded 视口（防溢出）；esc 落盘。
import React, { useState, useMemo } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import stringWidth from 'string-width'
import { useTheme, GUTTER } from './theme.js'
import type { SkillDefinition } from '../skillsLoader.js'
import type { SkillOverrideState } from '../config.js'
import { cycleSkillState, skillTokenCost, finalizeSkillOverrides } from '../skillsLoader.js'

const STATE_ICON: Record<SkillOverrideState, { glyph: string; color?: string; label: string }> = {
  'on': { glyph: '✓', color: 'green', label: 'on' },
  'name-only': { glyph: '•', label: 'name-only' },
  'user-invocable-only': { glyph: '○', color: 'yellow', label: 'user-only' },
  'off': { glyph: '✗', color: 'red', label: 'off' },
}

const NAME_CAP = 24
const firstLine = (s: string): string => s.split('\n').map(l => l.trim()).find(l => l) ?? ''

export interface SkillsViewProps {
  skills: SkillDefinition[]
  overrides: Record<string, SkillOverrideState>
  onExit: (newOverrides: Record<string, SkillOverrideState>) => void
}

export function SkillsView({ skills, overrides, onExit }: SkillsViewProps) {
  const T = useTheme()
  const { stdout } = useStdout()
  const [edited, setEdited] = useState<Record<string, SkillOverrideState>>({ ...overrides })
  const [cursor, setCursor] = useState(0)
  const [sortByToken, setSortByToken] = useState(false)
  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    let list = skills.map(s => ({ s, tok: skillTokenCost(s), state: (edited[s.name] ?? 'on') as SkillOverrideState }))
    if (query) {
      const q = query.toLowerCase()
      list = list.filter(x => x.s.name.toLowerCase().includes(q) || (x.s.description ?? '').toLowerCase().includes(q))
    }
    list = list.slice().sort((a, b) => sortByToken ? (b.tok - a.tok || a.s.name.localeCompare(b.s.name)) : a.s.name.localeCompare(b.s.name))
    return list
  }, [skills, edited, query, sortByToken])

  const clamped = Math.min(cursor, Math.max(0, visible.length - 1))

  useInput((input, key) => {
    if (key.escape) { onExit(finalizeSkillOverrides(edited)); return }
    if (key.upArrow) { setCursor(c => Math.max(0, Math.min(c, visible.length - 1) - 1)); return }
    if (key.downArrow) { setCursor(c => Math.min(visible.length - 1, Math.min(c, visible.length - 1) + 1)); return }
    if (key.ctrl && input === 's') { setSortByToken(v => !v); return }
    if (key.return || input === ' ') {
      const cur = visible[clamped]
      if (cur) setEdited(e => ({ ...e, [cur.s.name]: cycleSkillState(e[cur.s.name] ?? 'on') }))
      return
    }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); return }
    // 可打印字符进搜索（空格已被切态占用；Tab/ctrl/meta 组合不算）
    if (input && input.length >= 1 && input !== ' ' && input !== '\t' && !key.tab && !key.ctrl && !key.meta) {
      // 首次进搜索时若首字符是 /，剥掉（/ 进搜索不写字面斜杠）
      setQuery(q => q + (q === '' && input.startsWith('/') ? input.slice(1) : input))
    }
  })

  if (!skills.length) {
    return (
      <Box flexDirection="column" paddingX={GUTTER}>
        <Text bold>Skills</Text>
        <Text dimColor>（没有已加载的技能。按 Esc 返回）</Text>
      </Box>
    )
  }

  const columns = stdout?.columns ?? 80
  const rows = stdout?.rows ?? 24
  const nameW = Math.min(NAME_CAP, Math.max(4, ...visible.map(x => stringWidth(x.s.name))), Math.max(4, Math.floor(columns * 0.32)))
  // 视口：留出 header(1)+hint(1)+上下省略(2)+输入区(3) 的余量
  const WINDOW = Math.max(4, Math.min(visible.length, rows - 7))
  const start = Math.max(0, Math.min(clamped - Math.floor(WINDOW / 2), Math.max(0, visible.length - WINDOW)))
  const windowRows = visible.slice(start, start + WINDOW)
  const changed = Object.keys(finalizeSkillOverrides(edited)).length

  return (
    <Box flexDirection="column" paddingX={GUTTER}>
      <Text bold>Skills（{visible.length}{query ? `/${skills.length}` : ''}）{changed > 0 ? <Text dimColor>{`  ·  ${changed} 个非默认待保存`}</Text> : null}</Text>
      <Text dimColor>↑↓ 移动 · enter/space 切换态 · ctrl+s 排序（{sortByToken ? 'token' : '名称'}）· 输入过滤 · Esc 保存返回{query ? ` · 搜索:${query}` : ''}</Text>
      {start > 0 ? <Text dimColor>{`  ↑ 上面还有 ${start} 个`}</Text> : null}
      {windowRows.map((x, i) => {
        const sel = start + i === clamped
        const ico = STATE_ICON[x.state]
        const desc = firstLine(x.s.description ?? '')
        return (
          <Box key={x.s.name}>
            <Text color={sel ? T.accent : undefined}>{sel ? '❯ ' : '  '}</Text>
            <Text color={ico.color}>{ico.glyph} </Text>
            <Box width={nameW} flexShrink={0}>
              <Text wrap="truncate" color={sel ? T.accent : undefined}>{x.s.name}</Text>
            </Box>
            <Box width={9} flexShrink={0}>
              <Text dimColor wrap="truncate">{` ${x.tok} tok`}</Text>
            </Box>
            <Box width={12} flexShrink={0}>
              <Text color={ico.color} wrap="truncate">{ico.label}</Text>
            </Box>
            <Box flexShrink={1}>
              <Text wrap="truncate" dimColor>{desc ? `— ${desc}` : ''}</Text>
            </Box>
          </Box>
        )
      })}
      {start + WINDOW < visible.length ? <Text dimColor>{`  ↓ 下面还有 ${visible.length - start - WINDOW} 个`}</Text> : null}
      {visible.length === 0 ? <Text dimColor>（无匹配技能）</Text> : null}
    </Box>
  )
}
