import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { FleetView, statusIcon, tempoMark, nextSelection } from '../src/tui/FleetView.js'
import type { FleetRow } from '../src/fleet.js'

const jobRow = (id: string, over: any = {}): FleetRow => ({
  kind: 'job', job: { id, kind: 'task', backend: 'local', name: 'job-' + id, detail: 'doing', band: 'working', tempo: 'flowing', pinned: false, cwd: '/w', createdAt: 0, updatedAt: 0, ...over },
})

describe('statusIcon', () => {
  it('working 无 status → 转轮；终态 → ✓/✗/■', () => {
    expect(statusIcon({ band: 'working' } as any)).toBe('⟳')
    expect(statusIcon({ band: 'done', status: 'success' } as any)).toBe('✓')
    expect(statusIcon({ band: 'done', status: 'failed' } as any)).toBe('✗')
    expect(statusIcon({ band: 'done', status: 'stopped' } as any)).toBe('■')
  })
})

describe('FleetView 渲染', () => {
  it('空态提示', () => {
    const { lastFrame } = render(<FleetView rows={[]} selectedId={null} groupMode="state" peak={0} renamingBuffer={null} confirming={null} />)
    expect(lastFrame()).toContain('No background work')
  })
  it('渲染 header + job 名 + 选中标记', () => {
    const rows: FleetRow[] = [{ kind: 'header', group: 'working' }, jobRow('a')]
    const { lastFrame } = render(<FleetView rows={rows} selectedId="a" groupMode="state" peak={1} renamingBuffer={null} confirming={null} />)
    const f = lastFrame()!
    expect(f).toContain('working')
    expect(f).toContain('job-a')
    expect(f).toContain('❯')          // 选中箭头
    expect(f).toContain('峰值')        // 页脚
  })
  it('fold 行显示隐藏数', () => {
    const rows: FleetRow[] = [{ kind: 'header', group: 'done' }, jobRow('d1', { band: 'done', status: 'success' }), { kind: 'fold', hidden: 3 }]
    expect(render(<FleetView rows={rows} selectedId={null} groupMode="state" peak={0} renamingBuffer={null} confirming={null} />).lastFrame()).toContain('+3')
  })
  it('rename 态显示输入缓冲', () => {
    const rows: FleetRow[] = [jobRow('a')]
    expect(render(<FleetView rows={rows} selectedId="a" groupMode="state" peak={0} renamingBuffer="newname" confirming={null} />).lastFrame()).toContain('newname')
  })
  it('confirm 态显示确认提示', () => {
    const rows: FleetRow[] = [jobRow('a')]
    expect(render(<FleetView rows={rows} selectedId="a" groupMode="state" peak={0} renamingBuffer={null} confirming={{ id: 'a', action: 'stop' }} />).lastFrame()).toContain('确认')
  })
})

describe('nextSelection', () => {
  const ids = ['a', 'b', 'c']
  it('下移循环、上移循环', () => {
    expect(nextSelection(ids, 'a', 1)).toBe('b')
    expect(nextSelection(ids, 'c', 1)).toBe('a')
    expect(nextSelection(ids, 'a', -1)).toBe('c')
  })
  it('current 为空/不在列表 → 取首个', () => {
    expect(nextSelection(ids, null, 1)).toBe('a')
    expect(nextSelection(ids, 'zzz', 1)).toBe('a')
    expect(nextSelection([], 'a', 1)).toBe(null)
  })
})
