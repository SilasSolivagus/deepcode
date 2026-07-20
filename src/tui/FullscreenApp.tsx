// src/tui/FullscreenApp.tsx
// 全屏可滚变体（M8 P1）：alt-screen 全屏 + 键盘滚动（PageUp/PageDown/Ctrl+G）+ auto-follow。
// 复用 App 的全部接线，仅把转录渲染换成 ScrollView，并加滚动状态 + alt-screen 生命周期 +
// 绝对定位 IME 光标停泊。useChat 会话核心零改动。内联模式仍走 App。
import React, { useMemo, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawnSync } from 'node:child_process'
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from 'ink'
import { WorkflowView, formatWorkflowProgress, type WorkflowRunSummary } from './WorkflowView.js'
import { FleetPanel } from './FleetView.js'
import { SkillsView } from './SkillsView.js'
import { createChatCore, useChat } from './useChat.js'
import { foldTranscript, shouldFold } from './focusFold.js'
import { performTuiSwitch } from './tuiSwitch.js'
import { flushThenExit } from './exitFlush.js'
import { findMemoryFiles } from '../prompt.js'
import { computeSuggestions } from './suggest.js'
import { Banner } from './components/Banner.js'
import { ScrollView } from './ScrollView.js'
import { InputBox } from './components/InputBox.js'
import { Suggestions } from './components/Suggestions.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { PlanApprovalDialog } from './components/PlanApprovalDialog.js'
import { QuestionDialog } from './components/QuestionDialog.js'
import { SelectList } from './components/SelectList.js'
import { Spinner } from './components/Spinner.js'
import { StatusFooter } from './components/StatusFooter.js'
import { clamp, page, applyFollow, nextStuck, scrollInfo } from './scroll.js'
import { onWheel } from './wheel.js'
import { useThemeControl, themeNames, BLOCK_GAP, GUTTER } from './theme.js'
import { loadRawUserSettings, saveRawUserSettings } from '../config.js'

export function FullscreenApp(props: {
  client: any
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string
  flagSettingsPath?: string
  resumeFile?: string       // Task6：--resume <文件> 精确恢复
  justSwitched?: string     // Task6：/tui 切换后的首帧横幅（'inline'|'fullscreen'）
  unmount?: () => void      // Task6：ink 卸载回调（/tui 切换 spawnSync 前）
}) {
  // FullscreenApp = 全屏渲染器组件（App 传 false）；/focus 与折叠仅此组件可用。
  const isFullscreenComponent = true
  const { exit } = useApp()
  const { stdout } = useStdout()
  const core = useMemo(() => createChatCore({
    client: props.client,
    yolo: props.yolo,
    cwd: props.cwd,
    continueSession: props.continueSession,
    sessionDir: props.sessionDir,
    flagSettingsPath: props.flagSettingsPath,
    resumeFile: props.resumeFile,
    justSwitched: props.justSwitched,
    unmount: props.unmount,
    onState: () => {},
  }), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const state = useChat(core)
  const [draft, setDraft] = useState('')
  const [resumeMode, setResumeMode] = useState(false)
  const [modelPickerMode, setModelPickerMode] = useState(false)
  const [outputStyleMode, setOutputStyleMode] = useState(false)
  const [themeMode, setThemeMode] = useState(false)
  const { themeName, setThemeName } = useThemeControl()
  const [workflowsMode, setWorkflowsMode] = useState(false)
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([])
  const [fleetMode, setFleetMode] = useState(false)
  const [skillsMode, setSkillsMode] = useState(false)
  const [rewindStep, setRewindStep] = useState<'point' | 'mode' | null>(null)
  const [rewindTurn, setRewindTurn] = useState<number | null>(null)
  const [lastSigint, setLastSigint] = useState(0)
  const justPickedRef = useRef<string | null>(null)
  const [valueOverride, setValueOverride] = useState<{ text: string; nonce: number } | undefined>(undefined)

  // —— 滚动状态 ——
  // ScrollView 高 = min(内容高 totalH, 可用高 availableH=rows-bottomH)：内容矮则输入框紧跟其下，
  // 内容超屏才钉满可用高并裁剪滚动。viewportRef=availableH（翻页/跟随用）。
  const [scrollOffset, setScrollOffset] = useState(0)
  const scrollRef = useRef(0)
  const stuckRef = useRef(true)
  const [, setTick] = useState(0)
  const viewportRef = useRef(10)
  const totalRef = useRef(0)
  const [totalH, setTotalH] = useState(0)
  const [bottomH, setBottomH] = useState(8)
  const bottomRef = useRef<DOMElement | null>(null)
  const [info, setInfo] = useState(() => scrollInfo(0, 10, 0))
  const setOffset = (n: number) => { scrollRef.current = n; setScrollOffset(n) }

  // ScrollView 量内层内容高 → 上报（父据此算 height/maxScroll）
  const onMeasureTotal = useCallback((th: number) => {
    if (th !== totalRef.current) { totalRef.current = th; setTotalH(th) }
  }, [])

  useEffect(() => {
    if (state.pendingAsk || state.pendingQuestion || state.pendingPlanApproval || resumeMode || modelPickerMode || outputStyleMode || themeMode || workflowsMode || fleetMode || rewindStep || skillsMode) {
      setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    }
  }, [!!state.pendingAsk, !!state.pendingQuestion, !!state.pendingPlanApproval, resumeMode, modelPickerMode, outputStyleMode, themeMode, workflowsMode, fleetMode, rewindStep, skillsMode])  // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    if (key.escape && workflowsMode) { setWorkflowsMode(false); return }
    const ms = Math.max(0, totalRef.current - viewportRef.current)
    // 改 offset/stuck 后靠 setTick 触发重渲，info/跟随由下方 reconcile effect 统一重算
    if (key.pageUp) { stuckRef.current = false; setOffset(page(scrollRef.current, 'up', viewportRef.current, ms)); setTick(x => x + 1); return }
    if (key.pageDown) { const n = page(scrollRef.current, 'down', viewportRef.current, ms); stuckRef.current = nextStuck(n, ms); setOffset(n); setTick(x => x + 1); return }
    if (key.ctrl && input === 'g') { stuckRef.current = true; setOffset(ms); setTick(x => x + 1); return }
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      // 两次 Ctrl+C 也是杀进程的退出路径：必须先 await 有界 flushMemory，否则后台记忆提取子代理被杀、记忆没写成盘
      if (now - lastSigint < 2000) void flushThenExit(() => core.flushMemory(), exit, () => core.notice('info', '正在保存记忆…'))
      else setLastSigint(now)
    }
    // Shift+Tab 循环权限模式（default→acceptEdits→plan→default）。
    if (key.shift && key.tab && !state.busy && !state.pendingAsk && !state.pendingPlanApproval && !state.pendingQuestion && !resumeMode && !modelPickerMode && !outputStyleMode && !themeMode && !workflowsMode && !fleetMode && !rewindStep && !skillsMode) {
      void core.send('/cycle-mode')
    }
  })

  // 鼠标/触控板滚轮（P2）：上滚 = stuck=false + 上移；下滚 = 下移 + 到底重新跟随。每 notch 3 行。
  useEffect(() => onWheel(dir => {
    const ms = Math.max(0, totalRef.current - viewportRef.current)
    if (dir === 'up') { stuckRef.current = false; setOffset(clamp(scrollRef.current - 3, ms)) }
    else { const n = clamp(scrollRef.current + 3, ms); stuckRef.current = nextStuck(n, ms); setOffset(n) }
    setTick(x => x + 1)
  }), [])  // eslint-disable-line react-hooks/exhaustive-deps

  // alt-screen 生命周期由 startTui 在 render() 之前同步进入/退出——必须在 ink 首帧之前，
  // 否则 ink 先画到主屏、effect 再切 alt-screen 清屏归位，会与 ink log-update 的"光标在上帧底部"
  // 假设冲突导致整屏错位（banner 被顶出视口）。这里不再于 effect 内进 alt-screen。

  const handleDraftChange = (v: string) => {
    setDraft(v)
    if (justPickedRef.current !== null && v !== justPickedRef.current) justPickedRef.current = null
  }

  const suggestions = useMemo(() => {
    if (justPickedRef.current !== null && draft === justPickedRef.current) return []
    return computeSuggestions(draft, { cwd: props.cwd, customCommands: core.customCommands, skills: core.skills })
  }, [draft])  // eslint-disable-line react-hooks/exhaustive-deps

  const handlePick = (v: string) => {
    let newDraft: string
    if (v.startsWith('@')) newDraft = draft.replace(/@[\w./-]*$/, v)
    else newDraft = v
    justPickedRef.current = newDraft
    setDraft(newDraft)
    setValueOverride(prev => ({ text: newDraft, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  const isBackgroundCmd = (t: string) => t === '/background' || t === '/bg' || t.startsWith('/background ') || t.startsWith('/bg ')

  const handleBackgroundCommand = (text: string) => {
    const seed = text.replace(/^\/(background|bg)\s?/, '').trim() || undefined
    void (async () => {
      const ans = await core.askConfirm('把当前会话送到后台并释放终端？', '后台会话', '送到后台', '留在前台')
      if (!ans) return
      const r = await core.backgroundSession(seed)
      if (!r.ok) return // core 已 notice 失败原因；实为门控，留前台
      exit() // 释放终端，回 shell（子进程已 detached 继续跑）
    })()
  }

  const openWorkflowsView = () => {
    const journalDir = path.join(props.cwd, '.deepcode', 'workflows')
    const runs: WorkflowRunSummary[] = []
    try {
      for (const runId of fs.readdirSync(journalDir)) {
        try {
          const raw = fs.readFileSync(path.join(journalDir, runId, 'journal.jsonl'), 'utf8')
          const records = raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
          const isDone = records.some((r: any) => r.type === 'workflow_complete')
          runs.push(formatWorkflowProgress(records, { id: runId, status: isDone ? 'completed' : 'running' }))
        } catch { /* skip bad journal */ }
      }
    } catch { /* no journal dir */ }
    setWorkflowRuns(runs)
    setWorkflowsMode(true)
  }

  // /tui <inline|fullscreen>：切换渲染器（保存 settings.tui + 重启子进程恢复会话）。全逻辑委托 tuiSwitch.performTuiSwitch。
  const handleTuiSwitch = (text: string) => {
    const arg = text.slice('/tui'.length).trim().toLowerCase()
    const cur = isFullscreenComponent ? 'fullscreen' : 'inline'
    if (!arg) { core.notice('info', `当前渲染器：${cur}。用法：/tui <inline|fullscreen>`); return }
    if (arg !== 'inline' && arg !== 'fullscreen') { core.notice('info', `未知渲染器 "${arg}"。用法：/tui <inline|fullscreen>`); return }
    if (arg === cur) { core.notice('info', `已经在使用 ${arg} 渲染器。`); return }
    performTuiSwitch({
      target: arg as 'inline' | 'fullscreen',
      guardCtx: { bg: process.env.DEEPCODE_SESSION_KIND === 'bg', anyRunningWork: core.anyRunningWork() },
      state: { yolo: core.yolo(), settingsPath: props.flagSettingsPath },
      resume: { sessionFile: core.sessionFile(), hasTranscript: core.hasTranscript() },
      entryScript: process.argv[1],
      execPath: process.execPath,
      baseEnv: process.env,
      saveSettings: (p) => {
        try { const raw = loadRawUserSettings(); raw.tui = p.tui; saveRawUserSettings(raw); return { error: null } }
        catch (e: any) { return { error: e } }
      },
      unmount: core.unmount,
      spawnSync,
      exit: (c) => process.exit(c),
      onError: (m) => core.notice('warn', m),
    })
  }

  // /focus：切换 focus 视图（全屏折叠工具结果）。仅全屏渲染器可用；viewMode:focus 锁定时不可关。
  const handleFocus = () => {
    if (!isFullscreenComponent) { core.notice('info', 'focus 视图需要全屏渲染器。运行 /tui fullscreen 切换（会重启并恢复当前会话）。'); return }
    if (core.focusLocked()) { core.notice('info', 'focus 视图由 settings.json 的 "viewMode": "focus" 设定——在那里移除并重启即可关闭。'); return }
    const next = core.toggleFocus()
    core.notice('info', next ? '已开启 focus 视图' : '已关闭 focus 视图')
  }

  const submit = (text: string, attachments?: import('./pasteFold.js').Attachment[]) => {
    if (text === '/exit') {
      // 杀进程前先 await 有界 flushMemory：不等的话后台记忆提取子代理会被进程退出杀死，记忆没写成盘
      void flushThenExit(() => core.flushMemory(), exit, () => core.notice('info', '正在保存记忆…'))
      return
    }
    if (text === '/resume') { setResumeMode(true); return }
    if (text === '/model') { setModelPickerMode(true); return }
    if (text === '/output-style') { setOutputStyleMode(true); return }
    if (text === '/theme') { setThemeMode(true); return }
    if (text === '/rewind') { setRewindStep('point'); return }
    if (text === '/skills') { setSkillsMode(true); return }
    if (isBackgroundCmd(text)) { handleBackgroundCommand(text); return }
    if (text.trim().split(/\s+/)[0] === '/workflows') { openWorkflowsView(); return }
    if (text.trim().split(/\s+/)[0] === '/fleet') { setFleetMode(true); return }
    if (text.trim().split(/\s+/)[0] === '/tui') { handleTuiSwitch(text); return }
    if (text.trim() === '/focus') { handleFocus(); return }
    setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    void core.send(text, attachments)
  }

  const historyItems = state.transcript
    .filter(i => i.kind === 'user')
    .map(i => (i as { kind: 'user'; text: string }).text)

  // Task6：focus 视图折叠——仅全屏组件 + focusMode 时折叠工具结果；否则原样。
  const viewItems = shouldFold(isFullscreenComponent, core.focusMode())
    ? foldTranscript(state.transcript)
    : state.transcript

  const suggestionsActive = suggestions.length > 0

  const liveCwd = core.getCwd()
  const cwdBase = path.basename(liveCwd)
  const branch = useMemo(() => {
    try {
      return execSync('git branch --show-current', { cwd: liveCwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
    } catch { return null }
  }, [liveCwd])
  const memoryCount = useMemo(() => findMemoryFiles(props.cwd).length, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const modeLabel = (state.permMode === 'auto' ? 'auto' : state.permMode === 'acceptEdits' ? 'accept' : state.permMode === 'yolo' ? 'yolo' : state.permMode === 'plan' ? 'plan' : state.permMode === 'dontAsk' ? '⏵⏵DONT-ASK' : 'default')
    + (state.thinking ? '·think' : '')
  const toolCounts = useMemo(() => {
    const order: string[] = []
    const counts = new Map<string, number>()
    for (const it of state.transcript) {
      if (it.kind === 'tool') {
        if (!counts.has(it.name)) order.push(it.name)
        counts.set(it.name, (counts.get(it.name) ?? 0) + 1)
      }
    }
    return order.map(name => ({ name, n: counts.get(name)! }))
  }, [state.transcript])

  // —— 全屏几何（每帧算）——
  const rows = stdout?.rows ?? 24
  const availableH = Math.max(1, rows - bottomH)
  viewportRef.current = availableH
  // 内容矮 → 只占内容高（输入框紧跟）；内容超屏 → 钉满可用高裁剪。
  // totalH 未知(0)时先给满高：否则 0 高容器把内层也量成 0 → totalH 永卡 0 的死锁（banner 不显示）。
  const scrollH = totalH > 0 ? Math.min(totalH, availableH) : availableH

  // 量底部区域高（提示行+输入框/弹窗+页脚）→ 算可用高 → 应用 auto-follow + 位置提示。每帧跑，稳定后幂等不再 setState。
  useLayoutEffect(() => {
    try {
      const h = bottomRef.current ? measureElement(bottomRef.current).height : 0
      // 拒绝物理不可能的瞬态毛刺：底部区高 ≥ 屏高时 measureElement 偶发返回越界值（实测 80 on rows=55），
      // 会致 availableH=1 → scrollH=1（内容被挤没）。≥ 屏高一律忽略，保留上次有效值。
      if (h > 0 && h < (stdout?.rows ?? 24) && h !== bottomH) setBottomH(h)
    } catch { /* ignore */ }
    const avail = Math.max(1, (stdout?.rows ?? 24) - bottomH)
    viewportRef.current = avail
    const ms = Math.max(0, totalRef.current - avail)
    const next = applyFollow(scrollRef.current, ms, stuckRef.current)
    if (next !== scrollRef.current) setOffset(next)
    const ni = scrollInfo(next, avail, totalRef.current)
    setInfo(prev => (prev.moreAbove === ni.moreAbove && prev.moreBelow === ni.moreBelow
      && prev.top === ni.top && prev.bottom === ni.bottom && prev.total === ni.total) ? prev : ni)
  })

  return (
    <Box flexDirection="column" height={rows} paddingX={GUTTER}>
      <ScrollView
        items={viewItems}
        scrollOffset={scrollOffset}
        height={scrollH}
        onMeasureTotal={onMeasureTotal}
        banner={<Banner cwd={props.cwd} model={state.model} provider={core.providerName()} />}
      />
      <Box ref={bottomRef} flexDirection="column" flexShrink={0} marginTop={BLOCK_GAP}>
        <Text dimColor>
          {(info.moreAbove || info.moreBelow)
            ? `${info.moreAbove ? '▲ 上有更多' : '▲ 已到顶'} · ${info.moreBelow ? '▼ 下有更多' : '▼ 已到底'} · 行 ${info.top}–${info.bottom}/${info.total}${stuckRef.current ? ' · 跟随' : ''}`
            : ' '}
        </Text>
        {state.pendingQuestion
          ? <QuestionDialog questions={state.pendingQuestion.questions} onDone={a => core.resolveQuestion(a)} />
          : state.pendingAsk
          ? <PermissionDialog ask={state.pendingAsk} onDecide={d => core.resolveAsk(d)} />
          : state.pendingPlanApproval
          ? <PlanApprovalDialog pending={state.pendingPlanApproval} onDecide={approved => core.resolvePlanApproval(approved)} />
          : resumeMode
            ? <SelectList
                items={core.resumeList().map(s => s.preview)}
                onPick={i => { core.resume(core.resumeList()[i].file); setResumeMode(false) }}
                onCancel={() => setResumeMode(false)}
              />
            : modelPickerMode
            ? <SelectList
                items={core.modelList().map(m => m.label)}
                onPick={i => { const m = core.modelList()[i]; core.applyModel(m.id, m.providerId); setModelPickerMode(false) }}
                onCancel={() => setModelPickerMode(false)}
              />
            : outputStyleMode
            ? <SelectList
                items={core.outputStyleList().map(s => `${s.name}${s.description ? ' — ' + s.description : ''}`)}
                onPick={i => { core.applyOutputStyle(core.outputStyleList()[i].name); setOutputStyleMode(false) }}
                onCancel={() => setOutputStyleMode(false)}
              />
            : themeMode
            ? <SelectList
                items={themeNames().map(n => (n === themeName ? '● ' : '  ') + n)}
                onPick={i => {
                  const name = themeNames()[i]
                  setThemeName(name)
                  try { const raw = loadRawUserSettings(); raw.theme = name; saveRawUserSettings(raw) } catch { /* 持久化失败不阻断热切 */ }
                  setThemeMode(false)
                }}
                onCancel={() => setThemeMode(false)}
              />
            : workflowsMode
            ? <Box flexDirection="column">
                <WorkflowView runs={workflowRuns} />
                <Text dimColor>（按 Esc 返回）</Text>
              </Box>
            : fleetMode
            ? <FleetPanel cwd={props.cwd}
                onResumeSession={(file) => core.resume(file)}
                onOpenWorkflows={openWorkflowsView}
                onClose={() => setFleetMode(false)} />
            : skillsMode
            ? <SkillsView
                skills={core.skills}
                overrides={core.skillOverrides()}
                onExit={(o) => { core.saveSkillOverrides(o); setSkillsMode(false) }}
              />
            : rewindStep === 'point'
            ? (() => {
                const pts = core.rewindList()
                if (pts.length === 0) {
                  return <SelectList items={['暂无可回退的轮次（按 Esc 返回）']} onPick={() => setRewindStep(null)} onCancel={() => setRewindStep(null)} />
                }
                return <SelectList
                  items={pts.map(p => `第 ${p.turnId} 轮：${p.preview}${p.fileCount ? `（${p.fileCount} 文件改动）` : ''}`)}
                  onPick={i => { setRewindTurn(pts[i].turnId); setRewindStep('mode') }}
                  onCancel={() => setRewindStep(null)}
                />
              })()
            : rewindStep === 'mode'
            ? <SelectList
                items={['仅对话（截断历史，文件不动）', '仅代码（还原文件，对话不动）', '两者']}
                onPick={i => {
                  const mode = (['conversation', 'code', 'both'] as const)[i]
                  if (rewindTurn !== null) core.rewind(rewindTurn, mode)
                  setRewindStep(null); setRewindTurn(null)
                }}
                onCancel={() => { setRewindStep(null); setRewindTurn(null) }}
              />
            : <>
                {state.busy && <Spinner turnStartAt={state.turnStartAt} turnOutTokens={state.turnOutTokens} hookLabel={state.hookProgress} tip={state.spinnerTip} />}
                {suggestionsActive && <Suggestions items={suggestions} onPick={handlePick} />}
                <InputBox
                  onSubmit={submit}
                  onInterrupt={() => core.interrupt()}
                  onChange={handleDraftChange}
                  suggestionsActive={suggestionsActive}
                  history={historyItems}
                  busy={state.busy}
                  valueOverride={valueOverride}
                  onSteer={(t, a) => { if (isBackgroundCmd(t)) handleBackgroundCommand(t); else core.steer(t, a) }}
                  onSteerPop={() => { const v = core.steerPop(); if (v !== undefined) setValueOverride(prev => ({ text: v, nonce: (prev?.nonce ?? 0) + 1 })) }}
                  steerQueueSize={core.steerQueue().length}
                  steerQueueItems={core.steerQueue()}
                />
              </>
        }
        <StatusFooter
          model={state.model}
          mode={modeLabel}
          cwdBase={cwdBase}
          branch={branch}
          memoryCount={memoryCount}
          contextUsed={state.contextUsed()}
          contextWindow={state.contextWindow()}
          cost={state.sessionCost()}
          hitRate={state.cacheHitRate()}
          cacheSavings={state.cacheSavings()}
          tokenBudget={state.tokenBudget()}
          budgetUsed={state.budgetUsed()}
          thinking={state.thinking}
          effortLevel={state.effortLevel}
          toolCounts={toolCounts}
          statusLineOutput={state.statusLineOutput}
          focus={isFullscreenComponent && core.focusMode()}
        />
      </Box>
    </Box>
  )
}
