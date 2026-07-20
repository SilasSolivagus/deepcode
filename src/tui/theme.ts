// DeepSeek 主题系统：React context 化 + 六套主题
import React, { createContext, useContext, useState } from 'react'

export interface Theme {
  accent: string
  reasoning: string
  ok: string
  err: string
  warn: string
  dim: string
}

export const THEMES: Record<string, Theme> = {
  dark: {
    accent: '#6E8BFF',    // 鲸鱼蓝（深色终端更跳）
    reasoning: '#9B7EDE', // 思考流紫
    ok: '#4ADE80',
    err: '#F87171',
    warn: '#FBBF24',
    dim: 'gray',
  },
  light: {
    accent: '#2952CC',
    reasoning: '#6D28D9',
    ok: '#15803D',
    err: '#B91C1C',
    warn: '#B45309',
    dim: 'gray',
  },
  'dark-daltonized': {
    accent: '#3B82F6',
    reasoning: '#A78BFA',
    ok: '#38BDF8',
    err: '#F59E0B',
    warn: '#FDE047',
    dim: 'gray',
  },
  'light-daltonized': {
    accent: '#1D4ED8',
    reasoning: '#7C3AED',
    ok: '#0369A1',
    err: '#B45309',
    warn: '#A16207',
    dim: 'gray',
  },
  'dark-ansi': {
    accent: 'blueBright',
    reasoning: 'magenta',
    ok: 'greenBright',
    err: 'redBright',
    warn: 'yellowBright',
    dim: 'gray',
  },
  'light-ansi': {
    accent: 'blue',
    reasoning: 'magenta',
    ok: 'green',
    err: 'red',
    warn: 'yellow',
    dim: 'gray',
  },
}

export const DEFAULT_THEME: Theme = THEMES.dark

export function themeNames(): string[] {
  return Object.keys(THEMES)
}

interface ThemeCtx {
  theme: Theme
  themeName: string
  setThemeName: (n: string) => void
}

const Ctx = createContext<ThemeCtx>({
  theme: DEFAULT_THEME,
  themeName: 'dark',
  setThemeName: () => {},
})

export function ThemeProvider(p: { initial: string; children: React.ReactNode }): React.ReactElement {
  const [themeName, setThemeName] = useState(THEMES[p.initial] ? p.initial : 'dark')
  const theme = THEMES[themeName] ?? DEFAULT_THEME
  return React.createElement(Ctx.Provider, { value: { theme, themeName, setThemeName } }, p.children)
}

export function useTheme(): Theme {
  return useContext(Ctx).theme
}

export function useThemeControl(): { themeName: string; setThemeName: (n: string) => void } {
  const { themeName, setThemeName } = useContext(Ctx)
  return { themeName, setThemeName }
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// 工作 spinner：星号动画帧 + 中文俏皮动名词
export const SPINNER_SYMBOLS = ['✻', '✳', '✶', '✺', '✹', '✷']
export const THINKING_VERBS = ['琢磨中', '盘算中', '捣鼓中', '思索中', '合计中', '拾掇中', '盘点中', '鼓捣中', '推敲中', '寻思中']

// 栅格化间距常量（统一垂直节奏）：单一事实源。
export const GUTTER = 1     // 主容器左右 paddingX（左右各留 1 列）
export const BLOCK_GAP = 1  // transcript 块间 marginTop（块与块之间空一行）
