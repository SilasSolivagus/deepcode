// src/tui/FleetView.tsx
// 7.4 FleetView 渲染层（纯展示，键盘/动作在父组件接线时通过 useFleetKeys 挂）。
import React from 'react'
import { Box, Text, useInput } from 'ink'
import { PEAK_CONCURRENT_GOAL, type FleetRow, type FleetJob, type FleetTempo, type FleetGroupMode } from '../fleet.js'
import { useFleet } from './useFleet.js'

export function statusIcon(job: FleetJob): string {
  if (job.band === 'working') return '⟳'
  return job.status === 'success' ? '✓' : job.status === 'stopped' ? '■' : '✗'
}

function statusColor(job: FleetJob): string | undefined {
  if (job.band === 'working') return 'cyan'
  return job.status === 'success' ? 'green' : job.status === 'stopped' ? 'gray' : 'red'
}

export function tempoMark(t: FleetTempo): string {
  return t === 'flowing' ? '›' : t === 'slowing' ? '·' : '×'
}

export interface FleetViewProps {
  rows: FleetRow[]
  selectedId: string | null
  groupMode: FleetGroupMode
  peak: number
  renamingBuffer: string | null
  confirming: { id: string; action: 'stop' | 'delete' } | null
}

export function FleetView(props: FleetViewProps) {
  const { rows, selectedId, groupMode, peak, renamingBuffer, confirming } = props
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No background work. Dispatch with /background, the Agent tool, or a Workflow.</Text>
        <Text dimColor>（按 Esc 返回）</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text bold>Fleet · 分组:{groupMode === 'state' ? '状态' : '目录'}（ctrl+s 切）</Text>
      {rows.map((r, i) => {
        if (r.kind === 'header') return <Text key={'h' + i} bold dimColor>{'— ' + r.group + ' —'}</Text>
        if (r.kind === 'fold') return <Text key={'f' + i} dimColor>{'    … +' + r.hidden + ' done'}</Text>
        const job = r.job
        const sel = job.id === selectedId
        const isRenaming = sel && renamingBuffer !== null
        const isConfirming = confirming?.id === job.id
        const nameText = isRenaming ? renamingBuffer + '▏' : job.name
        return (
          <Box key={job.id}>
            <Text color={sel ? 'yellow' : undefined}>{sel ? '❯ ' : '  '}</Text>
            <Text color={statusColor(job)}>{statusIcon(job)} </Text>
            <Text>{tempoMark(job.tempo)} </Text>
            <Text color={sel ? 'yellow' : undefined}>{nameText}</Text>
            <Text dimColor>{'  [' + job.kind + '] ' + (job.detail ? job.detail.slice(0, 40) : '')}</Text>
            {isConfirming && <Text color="red">{'  ⚠ 确认' + (confirming!.action === 'stop' ? '停止' : '删除') + '？ctrl+x=是 esc=否'}</Text>}
          </Box>
        )
      })}
      <Text dimColor>{'峰值 ' + peak + '/目标 ' + PEAK_CONCURRENT_GOAL + ' · Enter 开 · ctrl+t 置顶 · ctrl+r 改名 · ctrl+x 停/删 · shift+↑↓ 排序 · ? 帮助 · Esc 退'}</Text>
    </Box>
  )
}

export function nextSelection(visibleIds: string[], current: string | null, dir: 1 | -1): string | null {
  if (visibleIds.length === 0) return null
  const idx = current === null ? -1 : visibleIds.indexOf(current)
  if (idx === -1) return visibleIds[0]
  const n = (idx + dir + visibleIds.length) % visibleIds.length
  return visibleIds[n]
}

export interface FleetKeysArgs {
  visibleJobs: FleetJob[]
  selectedId: string | null
  setSelectedId(id: string | null): void
  renaming: { id: string; buffer: string } | null
  setRenaming(r: { id: string; buffer: string } | null): void
  confirming: { id: string; action: 'stop' | 'delete' } | null
  setConfirming(c: { id: string; action: 'stop' | 'delete' } | null): void
  onOpen(job: FleetJob): void
  onStopOrDelete(job: FleetJob): void
  onPin(job: FleetJob): void
  onRename(job: FleetJob, name: string): void
  onReorder(job: FleetJob, dir: 1 | -1): void
  onToggleGroup(): void
  onToggleHelp(): void
  onClose(): void
}

/** FleetView 自持键盘：仅在面板挂载时生效（组件条件渲染保证）。 */
export function useFleetKeys(a: FleetKeysArgs): void {
  useInput((input, key) => {
    const sel = a.visibleJobs.find(j => j.id === a.selectedId) ?? null

    // rename 输入态：捕获字符/退格/回车/ESC
    if (a.renaming) {
      if (key.escape) { a.setRenaming(null); return }
      if (key.return) {
        const job = a.visibleJobs.find(j => j.id === a.renaming!.id)
        if (job) a.onRename(job, a.renaming!.buffer)
        a.setRenaming(null); return
      }
      if (key.backspace || key.delete) { a.setRenaming({ id: a.renaming.id, buffer: a.renaming.buffer.slice(0, -1) }); return }
      if (input && !key.ctrl && !key.meta) a.setRenaming({ id: a.renaming.id, buffer: a.renaming.buffer + input })
      return
    }

    // confirm 态：ctrl+x 确认、ESC 取消
    if (a.confirming) {
      if (key.escape) { a.setConfirming(null); return }
      if (key.ctrl && input === 'x') {
        const job = a.visibleJobs.find(j => j.id === a.confirming!.id)
        if (job) a.onStopOrDelete(job)
        a.setConfirming(null); return
      }
      return
    }

    if (key.escape) { a.onClose(); return }
    if (input === '?') { a.onToggleHelp(); return }

    // reorder：shift+↑/↓（部分终端 shift 不达时退化为普通箭头前需 shift，检 key.shift）
    if (key.shift && (key.upArrow || key.downArrow)) {
      if (sel) a.onReorder(sel, key.upArrow ? -1 : 1)
      return
    }
    if (key.upArrow) { a.setSelectedId(nextSelection(a.visibleJobs.map(j => j.id), a.selectedId, -1)); return }
    if (key.downArrow) { a.setSelectedId(nextSelection(a.visibleJobs.map(j => j.id), a.selectedId, 1)); return }
    if (key.return) { if (sel) a.onOpen(sel); return }

    if (key.ctrl && input === 's') { a.onToggleGroup(); return }
    if (key.ctrl && input === 't') { if (sel) a.onPin(sel); return }
    if (key.ctrl && input === 'r') { if (sel) a.setRenaming({ id: sel.id, buffer: sel.name }); return }
    if (key.ctrl && input === 'x') { if (sel) a.setConfirming({ id: sel.id, action: sel.band === 'working' ? 'stop' : 'delete' }); return }

    // alt+1..9 快开
    if (key.meta && /^[1-9]$/.test(input)) {
      const job = a.visibleJobs[Number(input) - 1]
      if (job) a.onOpen(job)
    }
  })
}

export interface FleetPanelProps {
  cwd: string
  onResumeSession(file: string): void   // = core.resume(file)
  onOpenWorkflows(): void               // = () => void core.send('/workflows')
  onClose(): void
}

/** FleetView 完整面板：顶层调 useFleet + useFleetKeys，供 App/FullscreenApp 无条件渲染。 */
export function FleetPanel(props: FleetPanelProps) {
  const fc = useFleet(props.cwd, true, (file) => { props.onResumeSession(file); props.onClose() })
  useFleetKeys({
    visibleJobs: fc.visibleJobs, selectedId: fc.selectedId, setSelectedId: fc.setSelectedId,
    renaming: fc.renaming, setRenaming: fc.setRenaming, confirming: fc.confirming, setConfirming: fc.setConfirming,
    onOpen: (job) => {
      if (job.kind === 'workflow') { props.onClose(); props.onOpenWorkflows() }
      else fc.openJob(job)   // session→resume（内部委托 onOpenSession）；task→no-op
    },
    onStopOrDelete: fc.stopOrDelete, onPin: fc.pin, onRename: fc.rename, onReorder: fc.reorder,
    onToggleGroup: fc.toggleGroup, onToggleHelp: fc.toggleHelp, onClose: props.onClose,
  })
  return (
    <Box flexDirection="column">
      <FleetView rows={fc.rows} selectedId={fc.selectedId} groupMode={fc.groupMode} peak={fc.peak}
        renamingBuffer={fc.renaming?.buffer ?? null} confirming={fc.confirming} />
    </Box>
  )
}
