// test/infoCommands.test.ts —— /status /skills /hooks /mcp 格式化器
import { describe, it, expect } from 'vitest'
import { formatSkillsList, formatHooksConfig, formatMcpStatus, formatStatus, formatDoctor } from '../src/infoCommands.js'

const skill = (over: any = {}) => ({ name: 'x', description: 'd', userInvocable: true, modelInvocable: true, context: 'inline', ...over })

describe('formatSkillsList', () => {
  it('列出模型可调用技能 + 描述首行', () => {
    const out = formatSkillsList([
      skill({ name: 'brainstorm', description: '头脑风暴\n第二行' }),
      skill({ name: 'ui-only', modelInvocable: false }),
    ] as any)
    expect(out).toContain('可用技能（1）')
    expect(out).toContain('· brainstorm — 头脑风暴')
    expect(out).not.toContain('ui-only') // 非 modelInvocable 不列
  })
  it('无可调用技能 → 友好提示', () => {
    expect(formatSkillsList([skill({ modelInvocable: false })] as any)).toBe('（无模型可调用的技能）')
  })
})

describe('formatHooksConfig 来源+内容', () => {
  it('空 hookLayers → 空态文案', () => {
    expect(formatHooksConfig([])).toContain('未配置任何 hook')
  })
  it('user command hook → 事件 + 命令内容 + [user]', () => {
    const out = formatHooksConfig([{ scope: 'user', hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit' }] }],
    } } as any])
    expect(out).toContain('PreToolUse:')
    expect(out).toContain('[Bash]')
    expect(out).toContain('echo audit')
    expect(out).toContain('[user]')
  })
  it('user + flag 两层同事件 → 两条各带来源', () => {
    const out = formatHooksConfig([
      { scope: 'user', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] } },
      { scope: 'flag', hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'b' }] }] } },
    ] as any)
    expect(out).toContain('[user]'); expect(out).toContain('[flag]')
    expect(out).toContain('a'); expect(out).toContain('b')
  })
  it('matcher 为 * 或空不显 []', () => {
    const out = formatHooksConfig([{ scope: 'user', hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] } } as any])
    expect(out).not.toContain('[*]')
  })
  it('长命令截断', () => {
    const long = 'x'.repeat(200)
    const out = formatHooksConfig([{ scope: 'user', hooks: { Stop: [{ hooks: [{ type: 'command', command: long }] }] } } as any])
    expect(out).toContain('…')
    expect(out).not.toContain('x'.repeat(200))
  })
})

describe('formatMcpStatus 三态', () => {
  it('空 → 空态文案', () => {
    expect(formatMcpStatus([], [])).toContain('未配置 MCP server')
  })
  it('connected + 工具 → ✓ + 工具数 + 短名', () => {
    const out = formatMcpStatus([{ name: 'github', status: 'connected' }], ['mcp__github__search', 'mcp__github__issues', 'Read'])
    expect(out).toContain('· github：✓ 已连接（2 个工具）')
    expect(out).toContain('search')
    expect(out).toContain('issues')
  })
  it('failed + error → ✗ + 错误原因', () => {
    const out = formatMcpStatus([{ name: 'db', status: 'failed', error: 'ECONNREFUSED 端口 5432' }], [])
    expect(out).toContain('✗ 连接失败')
    expect(out).toContain('ECONNREFUSED')
  })
  it('connected 0 工具 → 无工具标注', () => {
    expect(formatMcpStatus([{ name: 'x', status: 'connected' }], [])).toContain('（无工具）')
  })
  it('pending → 连接中', () => {
    expect(formatMcpStatus([{ name: 'y', status: 'pending' }], [])).toContain('连接中')
  })
  it('server 名归一化（含非法字符）', () => {
    const out = formatMcpStatus([{ name: 'my server', status: 'connected' }], ['mcp__my_server__t'])
    expect(out).toContain('· my server：✓ 已连接（1 个工具）')
  })
  it('error 超 200 字符截断', () => {
    const out = formatMcpStatus([{ name: 'z', status: 'failed', error: 'e'.repeat(300) }], [])
    expect(out).toContain('…')
    expect(out).not.toContain('e'.repeat(300))
  })
})

describe('formatStatus', () => {
  it('会话状态一览含关键字段', () => {
    const out = formatStatus({
      version: '0.8.1', model: 'glm-5.2', mode: 'auto', cwd: '/proj',
      branch: 'main', memoryCount: 1, skillsCount: 3, mcpServerCount: 2, toolCount: 40,
    })
    expect(out).toContain('deepcode v0.8.1')
    expect(out).toContain('模型：glm-5.2')
    expect(out).toContain('权限模式：auto')
    expect(out).toContain('/proj（分支 main）')
    expect(out).toContain('工具：40')
  })
  it('无分支时不显分支括号', () => {
    const out = formatStatus({ version: '1', model: 'm', mode: 'default', cwd: '/x', memoryCount: 0, skillsCount: 0, mcpServerCount: 0, toolCount: 1 })
    expect(out).toContain('工作目录：/x')
    expect(out).not.toContain('分支')
  })
})

describe('formatDoctor', () => {
  it('全 ok → 全部正常', () => {
    const out = formatDoctor([{ name: 'git', ok: true, detail: 'git 2.0' }, { name: 'Node', ok: true }])
    expect(out).toContain('全部正常')
    expect(out).toContain('✓ git：git 2.0')
    expect(out).toContain('✓ Node')
  })
  it('有失败 → 计数 + ✗ 标记', () => {
    const out = formatDoctor([{ name: 'API key', ok: false, detail: '未配置' }, { name: 'git', ok: true }])
    expect(out).toContain('1 项需注意')
    expect(out).toContain('✗ API key：未配置')
  })
})
