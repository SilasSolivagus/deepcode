import { describe, it, expect } from 'vitest'
import { isOverlyBroadAllowRule, loadLayeredSettings } from '../src/settingsLayers.js'
import { formatConfigReport } from '../src/configReport.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('isOverlyBroadAllowRule', () => {
  it('过宽：空内容 / 纯星号', () => {
    expect(isOverlyBroadAllowRule('Bash(*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash()')).toBe(true)
    expect(isOverlyBroadAllowRule('*')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash( * )')).toBe(true)
  })

  it('危险前缀：规则内容命中 DANGEROUS_PATTERNS', () => {
    expect(isOverlyBroadAllowRule('Bash(sudo:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(rm -rf:*)')).toBe(true)
  })

  it('正常规则不被误剥', () => {
    expect(isOverlyBroadAllowRule('Bash(npm test:*)')).toBe(false)
    expect(isOverlyBroadAllowRule('Read(src/**)')).toBe(false)
    expect(isOverlyBroadAllowRule('Bash(git status)')).toBe(false)
  })
})

describe('危险 allow 规则剥离与告知', () => {
  it('剥掉的规则出现在 strippedDangerousRules 且在报告里可见', () => {
    const fake: any = {
      settings: { permissions: { allow: ['Bash(npm test:*)'] } },
      provenance: {}, permissionSources: { allow: {}, deny: {}, ask: {} },
      scopes: [], hookLayers: [],
      strippedDangerousRules: ['Bash(*)', 'Bash(sudo:*)'],
    }
    const out = formatConfigReport(fake)
    expect(out).toContain('Bash(*)')
    expect(out).toContain('已忽略')
  })

  it('来源追溯一致性：被剥规则既不在 settings.permissions.allow 也不在 permissionSources.allow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-danger-allow-'))
    const flagFile = join(dir, 'flag.json')
    try {
      writeFileSync(flagFile, JSON.stringify({
        permissions: { allow: ['Bash(npm test:*)', 'Bash(*)', 'Bash(sudo:*)'] },
      }))
      const res = loadLayeredSettings(dir, flagFile)
      expect(res.settings.permissions.allow).toContain('Bash(npm test:*)')
      expect(res.settings.permissions.allow).not.toContain('Bash(*)')
      expect(res.settings.permissions.allow).not.toContain('Bash(sudo:*)')
      expect(res.permissionSources.allow['Bash(*)']).toBeUndefined()
      expect(res.permissionSources.allow['Bash(sudo:*)']).toBeUndefined()
      expect(res.permissionSources.allow['Bash(npm test:*)']).toBe('flag')
      expect(res.strippedDangerousRules).toEqual(expect.arrayContaining(['Bash(*)', 'Bash(sudo:*)']))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
