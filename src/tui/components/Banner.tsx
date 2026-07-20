// src/tui/components/Banner.tsx
// 启动欢迎框（双列欢迎页）：圆角 accent 框，左列（标题/欢迎/logo/账号/cwd，居中）+ │ + 右列（上手/小贴士/更新）。
// 防弹布局：不用 flex 行（ink/yoga 在 row 方向会阶梯错乱），改为每行手工拼等宽字符串——
// 左段先按可见宽居中补齐到 LEFT_W，再接 │ 与右段，整框是一列等宽 <Text> 行，边框必齐。
import React from 'react'
import os from 'node:os'
import path from 'node:path'
import { Box, Text } from 'ink'
import { useTheme } from '../theme.js'
import { VERSION } from '../../version.js'

// logo：终端提示符 + AI 火花——「命令行里的智能体」。极简、单 accent 色，一眼是 agent。
const LOGO = [
  ' ✦',
  '❯ ▌',
]

// 可见宽度：CJK/全角/emoji 计 2 列，其余 1 列
function dispWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
        (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
        (c >= 0xFE30 && c <= 0xFF60) || (c >= 0xFFE0 && c <= 0xFFE6) ||
        (c >= 0x1F000 && c <= 0x1FAFF) || (c >= 0x20000 && c <= 0x3FFFD)) w += 2
    else w += 1
  }
  return w
}
const padTo = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - dispWidth(s)))
const leftPad = (s: string, n: number) => ' '.repeat(Math.max(0, n)) + s

// 把绝对路径里的 home 前缀缩成 ~（如 ~/loop 显示）
function tildify(p: string, home: string = os.homedir()): string {
  if (p === home) return '~'
  const h = home.endsWith(path.sep) ? home : home + path.sep
  return p.startsWith(h) ? '~' + path.sep + p.slice(h.length) : p
}

type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean; logo?: boolean }

export function Banner(p: { cwd: string; model: string; provider: string }) {
  const T = useTheme()
  let user = ''
  try { user = os.userInfo().username } catch { /* 兜底空 */ }

  const left: Seg[] = [
    { text: `✦ deepcode v${VERSION}`, color: T.accent, bold: true },
    { text: user ? `欢迎回来，${user}！` : '欢迎使用 deepcode！', bold: true },
    { text: '' },
    ...LOGO.map(l => ({ text: l, color: T.accent, logo: true })),
    { text: '' },
    { text: `${p.model} · ${p.provider}`, dim: true },
    { text: tildify(p.cwd), dim: true },
    { text: '© Silas', dim: true },
  ]
  const right: Seg[] = [
    { text: '上手', color: T.accent, bold: true },
    { text: '输入 /help 看全部命令' },
    { text: '/init 生成 DEEPCODE.md' },
    { text: '' },
    { text: '小贴士', color: T.accent, bold: true },
    { text: '@ 引用文件 · ! 直跑 shell', dim: true },
    { text: '/model 切模型 · /think 开思考', dim: true },
    { text: '' },
    { text: '更新', color: T.accent, bold: true },
    { text: '· /rewind 回退对话与文件', dim: true },
    { text: '· 全屏可滚 + 触控板滚轮', dim: true },
  ]

  const LEFT_W = Math.max(...left.map(s => dispWidth(s.text)))
  const LOGO_W = Math.max(...LOGO.map(dispWidth))
  const logoPad = Math.floor((LEFT_W - LOGO_W) / 2)
  const rows = Math.max(left.length, right.length)
  const blank: Seg = { text: '' }

  // 左段居中：logo 按整块统一缩进（保形），其余每行各自按可见宽居中
  const center = (s: Seg) =>
    s.logo ? leftPad(s.text, logoPad) : leftPad(s.text, Math.floor((LEFT_W - dispWidth(s.text)) / 2))

  return (
    <Box borderStyle="round" borderColor={T.accent} paddingX={1} flexDirection="column">
      {Array.from({ length: rows }, (_, i) => {
        const l = left[i] ?? blank
        const r = right[i] ?? blank
        return (
          <Text key={i}>
            <Text color={l.color} dimColor={l.dim} bold={l.bold}>{padTo(center(l), LEFT_W)}</Text>
            <Text dimColor>{'   │   '}</Text>
            <Text color={r.color} dimColor={r.dim} bold={r.bold}>{r.text}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
