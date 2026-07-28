import { describe, it, expect } from 'vitest'
import { isSecurityGate, subagentPermissionDecision } from '../src/tools/agent.js'
import type { PermissionDecisionReason } from '../src/permissions.js'

describe('isSecurityGate', () => {
  it('S4 保护路径守卫 → 是网关', () => {
    expect(isSecurityGate({ type: 'other', reason: '保护路径守卫（目标是关键系统目录）' })).toBe(true)
  })
  it('工作目录围栏 → 是网关', () => {
    expect(isSecurityGate({ type: 'other', reason: '工作目录围栏' })).toBe(true)
  })
  it('deny 规则降级 → 是网关', () => {
    expect(isSecurityGate({ type: 'rule', rule: { source: 'builtin', behavior: 'deny', value: '**/id_rsa' } })).toBe(true)
  })
  it('ask 规则命中 → 是网关', () => {
    expect(isSecurityGate({ type: 'rule', rule: { source: 'user', behavior: 'ask', value: 'Bash(git push:*)' } })).toBe(true)
  })
  it('分类器判 ask → 是网关', () => {
    expect(isSecurityGate({ type: 'classifier', decision: 'ask' })).toBe(true)
  })
  it('allow 规则 → 不是网关', () => {
    expect(isSecurityGate({ type: 'rule', rule: { source: 'user', behavior: 'allow', value: 'Bash(ls:*)' } })).toBe(false)
  })
  it('无 reason（常规审批）→ 不是网关', () => {
    expect(isSecurityGate(undefined)).toBe(false)
  })
  it('其它 other 文案 → 不是网关（不做模糊匹配）', () => {
    expect(isSecurityGate({ type: 'other', reason: '用户拒绝了此操作' })).toBe(false)
  })
})

describe('subagentPermissionDecision', () => {
  it('网关来源一律拒，哪怕命令本身看着无害', () => {
    expect(subagentPermissionDecision('cat notes.md', { type: 'other', reason: '工作目录围栏' })).toBe('no')
  })

  // 回归：S4 守卫把 desc 重写成中文警告串，此前纯文本判定读不出危险 → rm -rf / 反被放行
  it('S4 守卫的警告串 desc + 网关 reason → 拒（语义反转回归）', () => {
    const warnDesc = "危险删除操作：'/'——目标是关键系统目录或工作目录，会造成不可逆破坏。"
    expect(subagentPermissionDecision(warnDesc, { type: 'other', reason: '保护路径守卫（根目录）' })).toBe('no')
  })

  it('无网关 + 危险命令 → 拒（沿用 isDangerous）', () => {
    expect(subagentPermissionDecision('sudo rm -rf /etc')).toBe('no')
  })

  it('无网关 + 常规命令 → 放行（不打断现有能力）', () => {
    expect(subagentPermissionDecision('npm test')).toBe('yes')
  })
})
