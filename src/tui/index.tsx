// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Silas <dirctable@gmail.com>
// deepcode — https://github.com/SilasSolivagus/deepcode
// src/tui/index.tsx
// TUI 入口：按逃生开关路由——内联 App vs 全屏 FullscreenApp（仅 TTY）。
// exitOnCtrlC: false 让根组件自管双击退出语义。
import React from 'react'
import { render } from 'ink'
import { App } from './App.js'
import { FullscreenApp } from './FullscreenApp.js'
import { ThemeProvider } from './theme.js'
import { enterAltScreen, installCleanup } from './altscreen.js'
import { makeFilteredStdin } from './mouseStdin.js'
import { emitWheel } from './wheel.js'
import { installTaskCleanup, cleanupOldTaskLogs } from '../tasks.js'
import { loadSettings } from '../config.js'
import { resolveRenderer } from './viewMode.js'
import { cleanupOldJobs, reconcileJobs } from '../backgroundSession.js'
import { cleanupOldSessions } from '../session.js'
import type OpenAI from 'openai'

export async function startTui(opts: {
  client: OpenAI
  yolo: boolean
  continueSession?: boolean
  inlineFlag?: boolean       // Task6：原始 --inline/DEEPCODE_INLINE 标志（决策链用，不折叠）
  resumeFile?: string        // Task6：--resume <文件> 精确恢复（交互路径 + /tui 切换回带）
  justSwitched?: string      // Task6：DEEPCODE_TUI_JUST_SWITCHED（'inline'|'fullscreen'）
  flagSettingsPath?: string
}): Promise<void> {
  // 后台任务：退出时 kill running 任务（追加监听，不抢占下方 altscreen 清理）+ 清理超龄旧日志。
  installTaskCleanup()
  cleanupOldTaskLogs()
  // 后台会话（7.3）：先校正僵尸 job（working 但 pid 已死 → failed），再清理超龄终态 job
  // （working 永不删），对齐 7 天 age-out 约定。
  reconcileJobs(Date.now())
  cleanupOldJobs(7 * 24 * 3600 * 1000, Date.now())
  // 会话历史保留（cleanupPeriodDays）：设了才清理超龄 .jsonl 会话。
  const cleanupDays = loadSettings(process.cwd(), opts.flagSettingsPath).cleanupPeriodDays
  if (cleanupDays) cleanupOldSessions(cleanupDays * 24 * 3600 * 1000, Date.now())
  // Task6：渲染器决策统一走 resolveRenderer（bg/isTTY/inlineFlag/settings.tui/settings.inline 决策链）。
  const renderer = resolveRenderer({
    bg: process.env.DEEPCODE_SESSION_KIND === 'bg',
    isTTY: !!process.stdout.isTTY,
    inlineFlag: !!opts.inlineFlag,
    settings: loadSettings(process.cwd(), opts.flagSettingsPath),
  })
  const Root = renderer === 'fullscreen' ? FullscreenApp : App
  const fullscreen = renderer === 'fullscreen'
  // 两种渲染器（TTY）都：ink render() 之前开括号粘贴（?2004h）+ 用过滤流喂 ink（剥粘贴标记、粘贴内回车
  // 不误提交），并由本处拥有退出还原。全屏另需同步进 alt-screen（备用屏+清屏+归位）+ 开 SGR 鼠标捕获
  // （滚轮滚动）；这些必须在 ink 首帧前做，放进组件 effect 会晚于首帧导致 log-update 光标假设错乱、整屏错位。
  let cleanupFull: (() => void) | undefined
  let customStdin: NodeJS.ReadStream | undefined
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?2004h') // 开括号粘贴
    let leaveAlt: (() => void) | undefined
    if (fullscreen) {
      leaveAlt = enterAltScreen(s => { process.stdout.write(s) })
      process.stdout.write('\x1b[?1000h\x1b[?1006h') // 开鼠标按钮事件（含滚轮）+ SGR 扩展坐标
    }
    const mf = makeFilteredStdin(process.stdin, { onWheel: fullscreen ? emitWheel : undefined })
    customStdin = mf.stdin
    const fullLeave = () => {
      if (fullscreen) { try { process.stdout.write('\x1b[?1000l\x1b[?1006l') } catch { /* ignore */ } } // 关鼠标捕获
      try { process.stdout.write('\x1b[?2004l') } catch { /* ignore */ } // 关括号粘贴
      mf.cleanup()
      leaveAlt?.()
    }
    const dispose = installCleanup(fullLeave)
    // 幂等：跑一次即返，防 finally 二次调（/tui 切换时经 unmount 提前调过一次）。
    let fullDone = false
    cleanupFull = () => { if (fullDone) return; fullDone = true; dispose(); fullLeave() }
  }
  try {
    const initialTheme = loadSettings().theme ?? 'dark'
    // Task6：捕获 ink instance，把 unmount 下传给 core（/tui 切换在 spawnSync 前卸载）。
    let instance: ReturnType<typeof render> | undefined
    // /tui 切换在 spawnSync 前调 unmount：卸 ink 之外还须还原终端（退 alt-screen+关鼠标捕获），
    // 否则子 inline app 跑在父 alt buffer + 鼠标捕获仍开 = 主路径坏。cleanupFull 幂等，finally 再调安全。
    const unmount = () => {
      try { instance?.unmount() } catch { /* ignore */ }
      try { cleanupFull?.() } catch { /* ignore */ }
    }
    instance = render(
      <ThemeProvider initial={initialTheme}>
        <Root
          client={opts.client as any}
          yolo={opts.yolo}
          cwd={process.cwd()}
          continueSession={opts.continueSession}
          flagSettingsPath={opts.flagSettingsPath}
          resumeFile={opts.resumeFile}
          justSwitched={opts.justSwitched}
          unmount={unmount}
        />
      </ThemeProvider>,
      { exitOnCtrlC: false, ...(customStdin ? { stdin: customStdin } : {}) },
    )
    await instance.waitUntilExit()
  } finally {
    cleanupFull?.()
  }
}
