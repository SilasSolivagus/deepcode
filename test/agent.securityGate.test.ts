import { describe, it, expect } from 'vitest'
import { isSecurityGate } from '../src/tools/agent.js'
import { checkPermission, WORKSPACE_FENCE_REASON, WORKFLOW_USAGE_CONFIRM_REASON, YOLO_DANGEROUS_CONFIRM_REASON, type PermissionDecisionReason, type PermissionContext } from '../src/permissions.js'
import type { Tool } from '../src/tools/types.js'

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

  it('workflow 用量确认 → 是网关', () => {
    expect(isSecurityGate({ type: 'other', reason: WORKFLOW_USAGE_CONFIRM_REASON })).toBe(true)
  })

  it('yolo 危险命令确认 → 是网关', () => {
    expect(isSecurityGate({ type: 'other', reason: YOLO_DANGEROUS_CONFIRM_REASON })).toBe(true)
  })
})

// 生产者（permissions.ts checkPermission）与消费者（isSecurityGate）耦合测试：
// 直接跑真实 checkPermission 拿到它实际产出的 reason，而不是各自维护一份字符串比对——
// 只改其中一处的文案（不改共享常量）就会在这里露馅，而不是静默失效。
describe('isSecurityGate 与 checkPermission 的生产者/消费者耦合', () => {
  const mkTool = (over: Partial<Tool<any>> = {}): Tool<any> => ({
    name: 'Write', description: 'w', inputSchema: {} as any, isReadOnly: false,
    needsPermission: () => '写入 /outside/evil.txt',
    workspacePaths: () => ['/outside/evil.txt'],
    call: async () => 'ok',
    ...over,
  })

  it('真实工作目录围栏触发的 reason，喂给 isSecurityGate 判定为网关', async () => {
    let captured: PermissionDecisionReason | undefined
    const pc: PermissionContext = {
      mode: 'default', rules: [], cwd: '/repo', saveRule: () => {},
      ask: async (_n, _d, reason) => { captured = reason; return 'no' },
    }
    const r = await checkPermission(mkTool(), {}, pc)
    expect(r.ok).toBe(false)
    expect(captured).toEqual({ type: 'other', reason: WORKSPACE_FENCE_REASON })
    expect(isSecurityGate(captured)).toBe(true)
  })

  it('真实 Workflow 用量确认门触发的 reason，喂给 isSecurityGate 判定为网关', async () => {
    let captured: PermissionDecisionReason | undefined
    const workflowTool: Tool<any> = {
      name: 'Workflow', description: 'w', inputSchema: {} as any, isReadOnly: true,
      needsPermission: () => '本次 workflow 预计消耗较多 token，是否继续？',
      call: async () => 'ok',
    }
    const pc: PermissionContext = {
      mode: 'default', rules: [], cwd: '/repo', saveRule: () => {},
      ask: async (_n, _d, reason) => { captured = reason; return 'no' },
    }
    const r = await checkPermission(workflowTool, {}, pc)
    expect(r.ok).toBe(false)
    expect(captured).toEqual({ type: 'other', reason: WORKFLOW_USAGE_CONFIRM_REASON })
    expect(isSecurityGate(captured)).toBe(true)
  })

  it('真实 yolo 危险命令门触发的 reason，喂给 isSecurityGate 判定为网关', async () => {
    let captured: PermissionDecisionReason | undefined
    const pc: PermissionContext = {
      mode: 'yolo', rules: [], cwd: '/repo', saveRule: () => {},
      ask: async (_n, _d, reason) => { captured = reason; return 'no' },
    }
    const tool = mkTool({ name: 'Bash', needsPermission: () => 'dd if=/dev/zero of=/dev/sda', workspacePaths: undefined })
    const r = await checkPermission(tool, {}, pc)
    expect(r.ok).toBe(false)
    expect(captured).toEqual({ type: 'other', reason: YOLO_DANGEROUS_CONFIRM_REASON })
    expect(isSecurityGate(captured)).toBe(true)
  })
})

// 注：原先这里还有一组 subagentPermissionDecision 用例。该函数在向上转发改造后已无生产调用方，
// 留着「非危险命令一律 yes」的语义+绿灯测试等于给旧的提权缺陷背书，故连函数一并删除；
// 它承载的行为断言全部迁到真生产路径 buildSubagentPermission（test/subagentRunner.askForward.test.ts）。
