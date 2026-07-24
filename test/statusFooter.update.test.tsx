import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { StatusFooter } from '../src/tui/components/StatusFooter.js'

const base = {
  model: 'deepseek-v4-pro', mode: 'default', cwdBase: 'loop', branch: null,
  memoryCount: 0, contextUsed: 0, contextWindow: 1_000_000, cost: 0,
  hitRate: 0, cacheSavings: 0, thinking: false, effortLevel: 'medium' as const,
  toolCounts: [],
}

describe('StatusFooter 升级状态', () => {
  it('upgraded 渲染已升至与重启提示', () => {
    const { lastFrame } = render(<StatusFooter {...base} updateStatus={{ phase: 'upgraded', latest: '0.9.3' }} />)
    expect(lastFrame()).toContain('已升至 0.9.3')
    expect(lastFrame()).toContain('重启生效')
  })

  it('available 渲染升级命令', () => {
    const { lastFrame } = render(
      <StatusFooter {...base} updateStatus={{ phase: 'available', latest: '0.9.3', command: 'npm i -g @silassolivagus/deepcode@latest' }} />,
    )
    expect(lastFrame()).toContain('有新版 0.9.3')
    expect(lastFrame()).toContain('npm i -g @silassolivagus/deepcode@latest')
  })

  it('过程态与未传值都不渲染该行', () => {
    const a = render(<StatusFooter {...base} updateStatus={{ phase: 'checking' }} />)
    expect(a.lastFrame()).not.toContain('✦')
    const b = render(<StatusFooter {...base} />)
    expect(b.lastFrame()).not.toContain('✦')
  })
})
