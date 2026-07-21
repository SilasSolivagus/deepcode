// src/tui/App.tsx
// 装配层：useChat + 全部组件 + 焦点路由。
// InputBox value 注入：通过 valueOverride={{ text, nonce }} prop 实现（最小改动，保持 InputBox 内部受控逻辑不变）。
// 补全菜单隐藏策略：onPick 后设置 justPickedValue，若 draft === justPickedValue 则不展示菜单；用户再输入时 draft 变化即恢复。
import React, { useMemo, useState, useRef, useEffect } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawnSync } from 'node:child_process'
import { Box, Text, useApp, useInput } from 'ink'
import { WorkflowView, formatWorkflowProgress, type WorkflowRunSummary } from './WorkflowView.js'
import { FleetPanel } from './FleetView.js'
import { SkillsView } from './SkillsView.js'
import { createChatCore, useChat } from './useChat.js'
import { foldTranscript, shouldFold } from './focusFold.js'
import { performTuiSwitch } from './tuiSwitch.js'
import { flushThenExit } from './exitFlush.js'
import { findMemoryFiles } from '../prompt.js'
import { parseHashMemory, writeHashMemory, type MemoryScope } from './hashMemory.js'
import { computeSuggestions } from './suggest.js'
import { Banner } from './components/Banner.js'
import { Transcript } from './components/Transcript.js'
import { InputBox } from './components/InputBox.js'
import { Suggestions } from './components/Suggestions.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { PlanApprovalDialog } from './components/PlanApprovalDialog.js'
import { QuestionDialog } from './components/QuestionDialog.js'
import { SelectList } from './components/SelectList.js'
import { Spinner } from './components/Spinner.js'
import { StatusFooter } from './components/StatusFooter.js'
import { useThemeControl, themeNames, BLOCK_GAP, GUTTER } from './theme.js'
import { loadRawUserSettings, saveRawUserSettings } from '../config.js'

export function App(props: {
  client: any
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string  // 测试注入：隔离 session 落盘目录
  flagSettingsPath?: string
  resumeFile?: string       // Task6：--resume <文件> 精确恢复
  justSwitched?: string     // Task6：/tui 切换后的首帧横幅（'inline'|'fullscreen'）
  unmount?: () => void      // Task6：ink 卸载回调（/tui 切换 spawnSync 前）
}) {
  // App = 内联渲染器组件（FullscreenApp 传 true）；/focus 与折叠仅全屏可用。
  const isFullscreenComponent = false
  const { exit } = useApp()
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
  const [rewindStep, setRewindStep] = useState<'point' | 'mode' | null>(null)
  const [rewindTurn, setRewindTurn] = useState<number | null>(null)
  const [workflowsMode, setWorkflowsMode] = useState(false)
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([])
  const [fleetMode, setFleetMode] = useState(false)
  const [skillsMode, setSkillsMode] = useState(false)
  // 行首 # 快速记忆：非 null 时持有待保存的记忆文本，作用域选择器打开中
  const [memPending, setMemPending] = useState<string | null>(null)
  const [lastSigint, setLastSigint] = useState(0)
  // 补全菜单隐藏：onPick 后记录刚选中的值，若 draft 恰好等于该值则不显示菜单
  const justPickedRef = useRef<string | null>(null)
  const lastEscRef = useRef(0)
  // InputBox value 注入：通过 nonce 强制 InputBox 接受新值
  const [valueOverride, setValueOverride] = useState<{ text: string; nonce: number } | undefined>(undefined)

  // pendingAsk / pendingPlanApproval / resumeMode / rewindStep / workflowsMode 激活时清除 draft 和 valueOverride，防止 InputBox 卸载后 remount 时老值复活
  useEffect(() => {
    if (state.pendingAsk || state.pendingQuestion || state.pendingPlanApproval || resumeMode || modelPickerMode || outputStyleMode || themeMode || rewindStep || workflowsMode || fleetMode || skillsMode || memPending !== null) {
      setDraft('')
      setValueOverride(undefined)
      justPickedRef.current = null
    }
  }, [!!state.pendingAsk, !!state.pendingQuestion, !!state.pendingPlanApproval, resumeMode, modelPickerMode, outputStyleMode, themeMode, rewindStep, workflowsMode, fleetMode, skillsMode, memPending !== null])  // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+C 两次退出（App 层统一管理，exitOnCtrlC: false 时才需要）
  // Ctrl+C 两次退出 + Shift+Tab 循环权限模式（default→acceptEdits→plan→default）。
  // Shift+Tab=ESC[Z，ink useInput 在多数终端识别为 key.tab+key.shift（QuestionDialog 亦用此键回上一题）；
  // 个别终端不识别时此分支静默不触发，可用 /plan、/accept 命令作保底。
  useInput((input, key) => {
    if (key.escape && workflowsMode) { setWorkflowsMode(false); return }
    // 双击 Esc（≤600ms）= 回退选择器（CC 的 rewind 入口），仅在纯空闲+输入框为空时触发；
    // 单 Esc 仍由 InputBox 处理（清空输入 / busy 时中断），不受影响。
    if (key.escape) {
      const idle = !state.busy && !state.pendingAsk && !state.pendingPlanApproval && !state.pendingQuestion
        && !resumeMode && !modelPickerMode && !outputStyleMode && !themeMode && !rewindStep
        && !workflowsMode && !fleetMode && !skillsMode && memPending === null && draft === ''
      if (idle) {
        const now = Date.now()
        if (now - lastEscRef.current < 600) { lastEscRef.current = 0; setRewindStep('point') }
        else lastEscRef.current = now
      }
      return
    }
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      // 两次 Ctrl+C 也是杀进程的退出路径：必须先 await 有界 flushMemory，否则后台记忆提取子代理被杀、记忆没写成盘
      if (now - lastSigint < 2000) void flushThenExit(() => core.flushMemory(), exit, () => core.notice('info', '正在保存记忆…'))
      else setLastSigint(now)
    }
    if (key.shift && key.tab && !state.busy && !state.pendingAsk && !state.pendingPlanApproval && !state.pendingQuestion && !resumeMode && !modelPickerMode && !outputStyleMode && !themeMode && !rewindStep && !workflowsMode && !fleetMode && !skillsMode && memPending === null) {
      void core.send('/cycle-mode')
    }
  })

  const handleDraftChange = (v: string) => {
    setDraft(v)
    // 用户有输入时清除 justPicked 记录（draft 已偏离 pick 结果）
    if (justPickedRef.current !== null && v !== justPickedRef.current) {
      justPickedRef.current = null
    }
  }

  const suggestions = useMemo(
    () => {
      // 刚刚 pick 后不显示菜单（防止选 /model 后立刻再弹出）
      if (justPickedRef.current !== null && draft === justPickedRef.current) return []
      return computeSuggestions(draft, { cwd: props.cwd, customCommands: core.customCommands, skills: core.skills })
    },
    [draft],  // eslint-disable-line react-hooks/exhaustive-deps
  )

  const handlePick = (v: string) => {
    let newDraft: string
    if (v.startsWith('@')) {
      // @补全：替换末尾的 @fragment
      newDraft = draft.replace(/@[\w./-]*$/, v)
    } else {
      // 斜杠补全：整行替换
      newDraft = v
    }
    justPickedRef.current = newDraft
    setDraft(newDraft)
    // 注入 InputBox 新值
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
    // 行首 # 快速记忆：有内容→打开作用域选择器（项目 / 全局）；空 #→提示，都不发给模型
    if (text.charAt(0) === '#') {
      const mem = parseHashMemory(text)
      if (mem !== null) { setMemPending(mem); return }
      core.notice('info', '记忆内容为空——# 后面写要记住的内容')
      return
    }
    setDraft('')
    setValueOverride(undefined)
    justPickedRef.current = null
    void core.send(text, attachments)
  }

  const historyItems = state.transcript
    .filter(i => i.kind === 'user')
    .map(i => (i as { kind: 'user'; text: string }).text)

  // Task6：focus 视图折叠——仅全屏组件 + focusMode 时折叠工具结果；内联组件恒不折叠。
  const viewItems = shouldFold(isFullscreenComponent, core.focusMode())
    ? foldTranscript(state.transcript)
    : state.transcript

  const suggestionsActive = suggestions.length > 0

  // —— 状态页脚数据 —— 跟随 cwd 动态更新（EnterWorktree 切换 cwd 后自动反映）
  const liveCwd = core.getCwd()
  const cwdBase = path.basename(liveCwd)
  const branch = useMemo(() => {
    try {
      return execSync('git branch --show-current', { cwd: liveCwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
    } catch { return null }
  }, [liveCwd])
  const memoryCount = useMemo(() => findMemoryFiles(props.cwd).length, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // 模式标签：权限模式 + thinking 后缀
  const modeLabel = (state.permMode === 'auto' ? 'auto' : state.permMode === 'acceptEdits' ? 'accept' : state.permMode === 'yolo' ? 'yolo' : state.permMode === 'plan' ? 'plan' : state.permMode === 'dontAsk' ? '⏵⏵DONT-ASK' : 'default')
    + (state.thinking ? '·think' : '')
  // 工具调用计数：按首次出现顺序分组（transcript 中 kind==='tool' 的条目）
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

  return (
    <Box flexDirection="column" paddingX={GUTTER}>
      {/* 欢迎框交给 Transcript 作为 Static 首项：开机出现、随对话滚入历史留存，不消失也不反复重画 */}
      <Transcript items={viewItems} banner={<Banner cwd={props.cwd} model={state.model} provider={core.providerName()} />} />
      <Box flexDirection="column" marginTop={BLOCK_GAP}>
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
          : memPending !== null
          ? <SelectList
              title={`保存记忆：「${memPending.length > 40 ? memPending.slice(0, 40) + '…' : memPending}」`}
              items={['项目记忆（./DEEPCODE.md）', '全局记忆（~/.deepcode/DEEPCODE.md，所有项目）']}
              onPick={i => {
                const scope: MemoryScope = i === 0 ? 'project' : 'global'
                try {
                  const p = writeHashMemory(scope, memPending, core.getCwd())
                  core.notice('info', `已保存记忆到 ${p}`)
                } catch (e) {
                  core.notice('warn', `保存记忆失败：${e instanceof Error ? e.message : String(e)}`)
                }
                setMemPending(null)
              }}
              onCancel={() => setMemPending(null)}
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
              {suggestionsActive && (
                <Suggestions items={suggestions} onPick={handlePick} />
              )}
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
      </Box>
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
  )
}
