import { describe, it, expect } from 'vitest'
import { isOverlyBroadAllowRule, loadLayeredSettings, stripUntrustedScope, strippedRulesNotice } from '../src/settingsLayers.js'
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

  it('新增的内建执行原语前缀：awk/gawk/find/make/sed/docker 授权即等价于任意命令执行', () => {
    expect(isOverlyBroadAllowRule('Bash(awk:*)')).toBe(true)     // system()
    expect(isOverlyBroadAllowRule('Bash(gawk:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(find:*)')).toBe(true)    // -exec/-execdir
    expect(isOverlyBroadAllowRule('Bash(make:*)')).toBe(true)    // $(shell …)/--eval
    expect(isOverlyBroadAllowRule('Bash(sed:*)')).toBe(true)     // GNU sed 的 e 命令
    expect(isOverlyBroadAllowRule('Bash(docker:*)')).toBe(true)  // -v /:/host 挂宿主根目录
  })

  it('等价拼写缺口：绝对路径形式与版本号后缀形式同样被剥', () => {
    expect(isOverlyBroadAllowRule('Bash(/usr/bin/python:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(/bin/sh:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(python3.11:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(node20:*)')).toBe(true)
    expect(isOverlyBroadAllowRule('Bash(/usr/bin/python3.11:*)')).toBe(true) // 路径+版本号叠加
  })

  it('等价拼写守卫：basename/去版本号后仍逐形态精确相等，不误剥名字撞前缀的合法工具', () => {
    expect(isOverlyBroadAllowRule('Bash(./scripts/python-lint:*)')).toBe(false) // basename=python-lint≠python
    expect(isOverlyBroadAllowRule('Bash(makefile-gen:*)')).toBe(false)         // ≠make
    expect(isOverlyBroadAllowRule('Bash(find-my-thing:*)')).toBe(false)        // ≠find
    expect(isOverlyBroadAllowRule('Bash(node_modules/.bin/tsc:*)')).toBe(false) // basename=tsc
  })

  it('判定排除项：git/kubectl 的危险形态是子命令/配置键级别，不是裸前缀——不加入清单', () => {
    // git -c core.pager="sh -c id" log 能执行任意命令，但 git -C dir status、git -c user.name=x
    // 这类完全无害的调用同样以 "git -" 开头——现有前缀表的匹配粒度是"整条规则内容"，
    // 加入裸 "git"/"kubectl" 会让这些常见良性规则一并被剥，误伤面比堵住的口子更大，故不加。
    expect(isOverlyBroadAllowRule('Bash(git -c core.pager=xxx:*)')).toBe(false)
    expect(isOverlyBroadAllowRule('Bash(kubectl:*)')).toBe(false)
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

describe('strippedRulesNotice：三入口共用的告知文案', () => {
  it('无剥离 → undefined（不产生噪音通知）', () => {
    expect(strippedRulesNotice([])).toBeUndefined()
    expect(strippedRulesNotice(undefined)).toBeUndefined()
  })

  it('有剥离 → 说清"不会生效"+ 列出规则 + 说明原因（过宽/危险）', () => {
    const msg = strippedRulesNotice(['Bash(npm run:*)', 'Bash(rm -rf dist)'])
    expect(msg).toBeDefined()
    expect(msg).toContain('Bash(npm run:*)')
    expect(msg).toContain('Bash(rm -rf dist)')
    expect(msg).toContain('不会生效') // 不是"已记录"这类暧昧措辞
    expect(msg).toMatch(/过宽|危险/) // 说明原因，不是只报个清单
  })
})

describe('不可信来源的配置剥离', () => {
  it('3.9 保留集不得被剥：model / maxToolResultChars 属低危·project 可贡献', () => {
    const { raw, stripped } = stripUntrustedScope({ maxToolResultChars: 999999999, model: 'x' })
    // 这两项只影响成本，不放松保护；3.9 设计经对抗评审判为低危、要管应走 clamp 而非整键剥离。
    expect(raw.maxToolResultChars).toBe(999999999)
    expect(raw.model).toBe('x')
    expect(stripped).not.toEqual(expect.arrayContaining(['model']))
    expect(stripped).not.toEqual(expect.arrayContaining(['maxToolResultChars']))
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
