import { describe, it, expect } from 'vitest'
import { formatUpdateStatus } from '../src/updater.js'

describe('formatUpdateStatus', () => {
  it('upgraded 显示已升至与重启提示', () => {
    expect(formatUpdateStatus({ phase: 'upgraded', latest: '0.9.3' }))
      .toBe('✦ 已升至 0.9.3 · 重启生效')
  })

  it('available 显示新版与升级命令', () => {
    expect(formatUpdateStatus({ phase: 'available', latest: '0.9.3', command: 'pnpm add -g @silassolivagus/deepcode@latest' }))
      .toBe('✦ 有新版 0.9.3 · pnpm add -g @silassolivagus/deepcode@latest')
  })

  it('failed 显示失败与手动命令', () => {
    expect(formatUpdateStatus({ phase: 'failed', command: 'npm i -g @silassolivagus/deepcode@latest' }))
      .toBe('✦ 升级失败 · npm i -g @silassolivagus/deepcode@latest')
  })

  it('过程态不渲染', () => {
    expect(formatUpdateStatus({ phase: 'idle' })).toBeNull()
    expect(formatUpdateStatus({ phase: 'checking' })).toBeNull()
    expect(formatUpdateStatus({ phase: 'upgrading', latest: '0.9.3' })).toBeNull()
  })
})
