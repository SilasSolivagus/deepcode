import { describe, it, expect } from 'vitest'
import { checkPermission, YOLO_DANGEROUS_CONFIRM_REASON, type PermissionContext, type Decision, type PermissionDecisionReason } from '../src/permissions.js'
import { readTool } from '../src/tools/read.js'

// 本文件的 fakeTool 故意不设 workspacePaths/deniablePaths，好让 checkPermission
// 直达 yolo 分支（:488）——工作目录围栏（:423）与 deny（:378）都要靠这两个字段
// 才会触发。后续维护若给 fakeTool 加上这两个字段，会让下面的用例被别的关卡
// 抢先拦下，产出与本门无关的假绿/假红。
const fakeTool = (name: string, isReadOnly: boolean, desc: false | string = 'x'): any => ({
  name, isReadOnly, needsPermission: () => desc,
})

function pc(over: Partial<PermissionContext> = {}): PermissionContext {
  return { mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no' as Decision, ...over }
}

describe('yolo 危险命令门', () => {
  it('yolo 下危险命令强制弹窗，用户拒绝则拒', async () => {
    let asked = false
    const r = await checkPermission(fakeTool('Bash', false, 'dd if=/dev/zero of=/dev/sda'), {}, pc({
      mode: 'yolo',
      ask: async () => { asked = true; return 'no' as Decision },
    }))
    expect(asked).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('yolo 下危险命令带结构化 reason（供无人值守侧识别）', async () => {
    let seen: PermissionDecisionReason | undefined
    await checkPermission(fakeTool('Bash', false, 'mkfs.ext4 /dev/sdb1'), {}, pc({
      mode: 'yolo',
      ask: async (_n, _d, reason) => { seen = reason; return 'no' as Decision },
    }))
    expect(seen).toEqual({ type: 'other', reason: YOLO_DANGEROUS_CONFIRM_REASON })
  })

  it('yolo 下用户放行则放行，但不写规则', async () => {
    let asked = false
    let saved: string | null = null
    const r = await checkPermission(fakeTool('Bash', false, 'sudo chown -R root /etc'), {}, pc({
      mode: 'yolo',
      ask: async () => { asked = true; return 'always' as Decision },
      saveRule: (rule: string) => { saved = rule },
    }))
    expect(asked).toBe(true) // 确实经过了强制确认，不是 yolo 直接放行
    expect(r.ok).toBe(true)
    expect(saved).toBeNull() // always 也不固化危险命令
  })

  it('yolo 下普通命令仍然零弹窗放行（不打废 yolo）', async () => {
    let asked = false
    const r = await checkPermission(fakeTool('Bash', false, 'npm test'), {}, pc({
      mode: 'yolo',
      ask: async () => { asked = true; return 'no' as Decision },
    }))
    expect(asked).toBe(false)
    expect(r.ok).toBe(true)
  })
})

describe('deny 命中后 hook 不得放行', () => {
  // paths 是唯一变量：命中 deny 与否，全靠工具桩报出的可 deny 路径决定。
  const bashTool = (cmd: string, paths: string[]): any => ({
    name: 'Bash', isReadOnly: false,
    needsPermission: () => cmd,
    deniablePaths: () => paths,
  })
  const allowHook = { onRequest: async () => ({ permission: 'allow' }) } as any

  it('攻击：deny 命中 Bash 后 PermissionRequest hook 返回 allow → 仍不得放行，且改由人拍板', async () => {
    let asked = false
    let askReason: PermissionDecisionReason | undefined
    const r = await checkPermission(
      bashTool('cat /home/u/.ssh/id_rsa', ['/home/u/.ssh/id_rsa']), {},
      pc({
        deny: ['**/id_rsa'],
        ask: async (_n, _d, reason) => { asked = true; askReason = reason; return 'no' as Decision },
      }),
      allowHook,
    )
    expect(r.ok).toBe(false)
    // 不是"hook allow 被无声吞掉直接硬拒"，而是 fall through 到尾部 ask 交人决定，
    // 且带着 deny 归因——「绝不静默失效」要求这条链路可观测。
    expect(asked).toBe(true)
    expect(askReason).toEqual({ type: 'rule', rule: { source: 'builtin', behavior: 'deny', value: '**/id_rsa' } })
  })

  it('回归：未命中 deny 时 hook 的 allow 仍然生效（不打废 hook）', async () => {
    let asked = false
    const r = await checkPermission(
      bashTool('npm test', []), {},
      pc({
        deny: ['**/id_rsa'],
        ask: async () => { asked = true; return 'no' as Decision },
      }),
      allowHook,
    )
    expect(r.ok).toBe(true)
    expect(asked).toBe(false) // hook 放行，没走到 ask
  })
})

describe('auto 模式 Edit/Write 恢复 hard_deny', () => {
  const writeTool = (desc: string): any => ({
    name: 'Write', isReadOnly: false, needsPermission: () => desc,
  })

  it('攻击：auto 下 Write 命中 hard_deny → 被拦（此前 fast-path 直接放行）', async () => {
    let classified = 0
    const r = await checkPermission(writeTool('echo x >> ~/.ssh/authorized_keys'), {}, pc({
      mode: 'auto',
      classify: async () => { classified++; return 'run' },
    }))
    expect(r.ok).toBe(false)
    expect(classified).toBe(0) // hard_deny 是静态判定，不该惊动分类器
  })

  it('回归：auto 下普通 Write 仍走 fast-path，不调分类器（保住 ~3s 延迟优化）', async () => {
    let classified = 0
    const r = await checkPermission(writeTool('write src/a.ts'), {}, pc({
      mode: 'auto',
      classify: async () => { classified++; return 'run' },
    }))
    expect(r.ok).toBe(true)
    expect(classified).toBe(0)
  })
})

describe('只读工具的 ask 防护走路径维度', () => {
  const CONFIG = '/repo/config.json'

  it('路径维度：裸 glob ask 规则命中只读工具的路径 → 强制弹窗，拒则拒', async () => {
    let asked = false
    let askReason: PermissionDecisionReason | undefined
    const r = await checkPermission(readTool, { file_path: CONFIG }, pc({
      cwd: '/repo',
      askRules: ['**/config.json'],
      ask: async (_n, _d, reason) => { asked = true; askReason = reason; return 'no' as Decision },
    }))
    expect(asked).toBe(true) // 只读短路没能把它吞掉
    expect(r.ok).toBe(false)
    expect(askReason).toEqual({
      type: 'rule',
      rule: { source: 'user', behavior: 'ask', value: '**/config.json' },
    })
  })

  it('回归：路径不命中裸 glob 时，只读工具仍零弹窗放行', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/repo/other.json' }, pc({
      cwd: '/repo',
      askRules: ['**/config.json'],
      ask: async () => { asked = true; return 'no' as Decision },
    }))
    expect(asked).toBe(false)
    expect(r.ok).toBe(true)
  })

  // 钉住既定语义：命令维度规则只保护「有具体动作描述」的工具，只读工具没有描述
  // （needsPermission 恒 false），故天然不适用；它们的防护本就该走上面那条路径维度。
  // 这不是缺口。
  // 注意本用例能钉住的是「needsPermission 恒 false」这个事实断言——行为断言那两条
  // 由 isReadOnly 短路与 desc===false 短路双重兜底，单独移除任一道都不会让它们变红。
  // 若将来有人给只读工具加上真实 needsPermission 描述，第三条断言会红，
  // 提醒他一并评估弹窗文案／suggestRule／isDangerous／subagentPermissionDecision 的连带影响。
  it('既定语义：Tool(pattern) 命令维度规则对只读工具不触发', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: CONFIG }, pc({
      cwd: '/repo',
      askRules: ['Read(config.json)'],
      ask: async () => { asked = true; return 'no' as Decision },
    }))
    expect(asked).toBe(false)
    expect(r.ok).toBe(true)
    expect(readTool.needsPermission({ file_path: CONFIG } as any)).toBe(false) // 根因就在这
  })
})
