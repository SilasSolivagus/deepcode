import { describe, it, expect } from 'vitest'
import { throttledPrompt, type UpdateCheckState, type InstallInfo } from '../src/updater.js'

const install: InstallInfo = { kind: 'npm-global', upgradeCommand: 'npm i -g @silassolivagus/deepcode@latest' }

describe('throttledPrompt', () => {
  it('缓存版本比当前新 → available，command 取自 install', () => {
    const state: UpdateCheckState = { lastCheckAt: 1, latest: '0.9.5' }
    expect(throttledPrompt(state, '0.9.2', install)).toEqual({
      phase: 'available', latest: '0.9.5', command: 'npm i -g @silassolivagus/deepcode@latest',
    })
  })

  it('缓存版本不比当前新 → null', () => {
    const state: UpdateCheckState = { lastCheckAt: 1, latest: '0.9.2' }
    expect(throttledPrompt(state, '0.9.2', install)).toBeNull()
  })

  it('state 缺失 → null', () => {
    expect(throttledPrompt(null, '0.9.2', install)).toBeNull()
  })

  it('state 里没有 latest → null', () => {
    const state: UpdateCheckState = { lastCheckAt: 1 }
    expect(throttledPrompt(state, '0.9.2', install)).toBeNull()
  })

  it('state 里 latest 非法（无法比较）→ null', () => {
    const state: UpdateCheckState = { lastCheckAt: 1, latest: 'not-a-version' }
    expect(throttledPrompt(state, '0.9.2', install)).toBeNull()
  })

  it('安装形态 dev → 即使有新版也 null', () => {
    const state: UpdateCheckState = { lastCheckAt: 1, latest: '0.9.5' }
    expect(throttledPrompt(state, '0.9.2', { kind: 'dev', upgradeCommand: 'x' })).toBeNull()
  })
})
