import { describe, it, expect } from 'vitest'
import { isOverlyBroadAllowRule, loadLayeredSettings, stripUntrustedScope } from '../src/settingsLayers.js'
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

  it('授权即任意代码执行的前缀：解释器 / 包运行器 / shell / 包装器', () => {
    expect(isOverlyBroadAllowRule('Bash(python:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(node:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(npm run:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(npx:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(bash:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(env:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(xargs:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(ssh:*)')).toBe(true)
  })

  it('代码执行前缀的各种形态与大小写变体', () => {
    expect(isOverlyBroadAllowRule('Bash(python)')).toBe(true)      // 精确
    expect(isOverlyBroadAllowRule('Bash(python*)')).toBe(true)     // 尾通配
    expect(isOverlyBroadAllowRule('Bash(python *)')).toBe(true)    // 空格通配
    expect(isOverlyBroadAllowRule('Bash(python -c*)')).toBe(true)  // 带参通配
    expect(isOverlyBroadAllowRule('Bash(PYTHON:*)')).toBe(true)    // 大小写
    expect(isOverlyBroadAllowRule('Bash(Sudo apt-get:*)')).toBe(true)
  })

  it('正常规则不被误剥', () => {
    expect(isOverlyBroadAllowRule('Bash(npm test:*)')).toBe(false)
    expect(isOverlyBroadAllowRule('Read(src/**)')).toBe(false)
    expect(isOverlyBroadAllowRule('Bash(git status)')).toBe(false)
    expect(isOverlyBroadAllowRule('Bash(git push:*)')).toBe(false)
  })

  it('前缀表逐形态精确相等，不做 startsWith——名字撞前缀的合法工具不得误剥', () => {
    expect(isOverlyBroadAllowRule('Bash(nodemon:*)')).toBe(false)  // node
    expect(isOverlyBroadAllowRule('Bash(shellcheck:*)')).toBe(false) // sh
    expect(isOverlyBroadAllowRule('Bash(envsubst:*)')).toBe(false) // env
    expect(isOverlyBroadAllowRule('Bash(timeout-report:*)')).toBe(false) // timeout
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

describe('不可信来源的配置剥离', () => {
  it('顶层危险键补齐：maxToolResultChars / model', () => {
    const { raw, stripped } = stripUntrustedScope({ maxToolResultChars: 999999999, model: 'x' })
    expect(raw.maxToolResultChars).toBeUndefined()
    expect(raw.model).toBeUndefined()
    expect(stripped).toEqual(expect.arrayContaining(['maxToolResultChars', 'model']))
  })

  it('顶层危险键补齐：outputStyle（能省掉整段编码纪律，同 language）', () => {
    const { raw, stripped } = stripUntrustedScope({ outputStyle: 'terse' })
    expect(raw.outputStyle).toBeUndefined()
    expect(stripped).toEqual(expect.arrayContaining(['outputStyle']))
  })

  it('只会更严的权限键必须保留：permissions.deny / permissions.ask', () => {
    const { raw, stripped } = stripUntrustedScope({
      permissions: { deny: ['**/.env'], ask: ['**/secrets/**'], allow: ['Bash(x)'] },
    })
    // deny/ask 只会让限制更严——项目仓库声明自己的禁区是正当防护，不得剥掉。
    expect(raw.permissions.deny).toEqual(['**/.env'])
    expect(raw.permissions.ask).toEqual(['**/secrets/**'])
    expect(stripped).not.toEqual(expect.arrayContaining(['permissions.deny']))
    expect(stripped).not.toEqual(expect.arrayContaining(['permissions.ask']))
    // allow 仍按既有行为剥离（会放松保护）
    expect(raw.permissions.allow).toBeUndefined()
  })

  it('回归：无关键不受影响', () => {
    const { raw } = stripUntrustedScope({ compactTokens: 123 })
    expect(raw.compactTokens).toBe(123)
  })
})
