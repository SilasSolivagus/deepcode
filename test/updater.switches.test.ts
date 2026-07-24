import { describe, it, expect } from 'vitest'
import { updatesDisabled, autoUpgradeAllowed } from '../src/updater.js'
import { DANGEROUS_TOP_KEYS } from '../src/settingsLayers.js'

describe('updatesDisabled', () => {
  it('DEEPCODE_DISABLE_UPDATES=1 全关', () => {
    expect(updatesDisabled({ DEEPCODE_DISABLE_UPDATES: '1' })).toBe(true)
  })
  it('未设或空值不关', () => {
    expect(updatesDisabled({})).toBe(false)
    expect(updatesDisabled({ DEEPCODE_DISABLE_UPDATES: '' })).toBe(false)
  })
})

describe('autoUpgradeAllowed', () => {
  it('默认允许', () => {
    expect(autoUpgradeAllowed({}, undefined)).toBe(true)
  })
  it('settings.autoUpdates:false 关自动升级', () => {
    expect(autoUpgradeAllowed({}, false)).toBe(false)
  })
  it('autoUpdates:true 显式允许', () => {
    expect(autoUpgradeAllowed({}, true)).toBe(true)
  })
  it('DEEPCODE_DISABLE_AUTOUPDATER=1 关自动升级', () => {
    expect(autoUpgradeAllowed({ DEEPCODE_DISABLE_AUTOUPDATER: '1' }, true)).toBe(false)
  })
  it('全关开关也隐含关闭自动升级', () => {
    expect(autoUpgradeAllowed({ DEEPCODE_DISABLE_UPDATES: '1' }, true)).toBe(false)
  })
})

describe('autoUpdates 信任边界', () => {
  it('autoUpdates 在 DANGEROUS_TOP_KEYS 里（项目层不可写）', () => {
    expect(DANGEROUS_TOP_KEYS as readonly string[]).toContain('autoUpdates')
  })
})
