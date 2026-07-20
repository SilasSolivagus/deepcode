// test/promptSections.test.ts
import { describe, it, expect } from 'vitest'
import { SYSTEM_SECTION, DOING_TASKS_SECTION, TOOLS_SECTION, CARE_SECTION, TONE_SECTION, buildSystemPrompt, languageSection } from '../src/prompt.js'

describe('SYSTEM_SECTION', () => {
  it('以 # 系统 标题开头', () => {
    expect(SYSTEM_SECTION.startsWith('# 系统')).toBe(true)
  })
  it('含 prompt injection 上报规则', () => {
    expect(SYSTEM_SECTION).toContain('prompt injection')
  })
  it('含 <system-reminder> 不权威规则', () => {
    expect(SYSTEM_SECTION).toContain('<system-reminder>')
  })
  it('含「拒绝后不重试同一调用」规则', () => {
    expect(SYSTEM_SECTION).toContain('不要重试完全相同的调用')
  })
})

describe('DOING_TASKS_SECTION', () => {
  it('以 # 干活 开头', () => {
    expect(DOING_TASKS_SECTION.startsWith('# 干活')).toBe(true)
  })
  it('保留 deepcode 强项：验证产物能用再报完成', () => {
    expect(DOING_TASKS_SECTION).toContain('报告完成前先实际验证')
  })
  it('保留 deepcode 强项：如实汇报不暗示成功', () => {
    expect(DOING_TASKS_SECTION).toContain('不要假装成功')
  })
  it('含新规则：别给时间估算', () => {
    expect(DOING_TASKS_SECTION).toContain('时间估算')
  })
  it('含新规则：被卡别反复重试', () => {
    expect(DOING_TASKS_SECTION).toContain('换路子')
  })
  it('含新规则：别对没读过的代码提改动建议', () => {
    expect(DOING_TASKS_SECTION).toContain('没读过')
  })
  it('含新规则：OWASP 安全', () => {
    expect(DOING_TASKS_SECTION).toContain('OWASP')
  })
  it('含极简：别给没改的代码加注释/类型', () => {
    expect(DOING_TASKS_SECTION).toContain('没改动的代码')
  })
  it('不再含 HTML 优于 curses 偏好', () => {
    expect(DOING_TASKS_SECTION).not.toContain('HTML')
    expect(DOING_TASKS_SECTION).not.toContain('curses')
  })
  it('含任务管理指引（用 TaskCreate/TaskUpdate、立即标完成、不批量）', () => {
    expect(DOING_TASKS_SECTION).toContain('TaskCreate/TaskUpdate')
    expect(DOING_TASKS_SECTION).toContain('立即把它标 completed')
  })
  it('含「绝不编造/猜测 URL」守卫', () => {
    expect(DOING_TASKS_SECTION).toMatch(/绝不.*URL|URL.*除非/)
  })
})

describe('TOOLS_SECTION', () => {
  it('以 # 用好工具 开头', () => {
    expect(TOOLS_SECTION.startsWith('# 用好工具')).toBe(true)
  })
  it('含并行只读调用规则', () => {
    expect(TOOLS_SECTION).toContain('并行')
  })
  it('含完整工具路由（Edit 不 sed/Write 不 heredoc）', () => {
    expect(TOOLS_SECTION).toContain('sed')
    expect(TOOLS_SECTION).toContain('heredoc')
  })
  it('含子代理别重复干活', () => {
    expect(TOOLS_SECTION).toContain('子代理')
  })
})

describe('CARE_SECTION', () => {
  it('以 # 谨慎执行破坏性动作 开头', () => {
    expect(CARE_SECTION.startsWith('# 谨慎执行破坏性动作')).toBe(true)
  })
  it('含可逆性/影响范围核心概念', () => {
    expect(CARE_SECTION).toContain('可逆性')
    expect(CARE_SECTION).toContain('影响范围')
  })
  it('含授权范围规则（一次批准≠永久）', () => {
    expect(CARE_SECTION).toContain('一次')
    expect(CARE_SECTION).toContain('范围')
  })
  it('含三类破坏性例子（rm -rf / force-push / 发消息）', () => {
    expect(CARE_SECTION).toContain('rm -rf')
    expect(CARE_SECTION).toContain('force-push')
    expect(CARE_SECTION).toContain('发消息')
  })
  it('含「别用破坏性动作走捷径」+ 意外状态先调查', () => {
    expect(CARE_SECTION).toContain('--no-verify')
    expect(CARE_SECTION).toContain('调查')
  })
})

describe('TONE_SECTION', () => {
  it('以 # 语气与风格 开头', () => {
    expect(TONE_SECTION.startsWith('# 语气与风格')).toBe(true)
  })
  it('含 file:line 引用规则', () => {
    expect(TONE_SECTION).toContain('src/loop.ts:42')
  })
  it('含「先给答案再给理由」', () => {
    expect(TONE_SECTION).toContain('先给答案')
  })
  it('含不用 emoji 规则', () => {
    expect(TONE_SECTION).toContain('emoji')
  })
})

describe('verified-vs-assumed 报告纪律', () => {
  it('DOING_TASKS_SECTION 含区分验证/假设的纪律', () => {
    expect(DOING_TASKS_SECTION).toContain('别把假设当事实断言')
  })
  it('buildSystemPrompt 默认注入该纪律', () => {
    const sp = buildSystemPrompt('/tmp')
    expect(sp).toContain('别把假设当事实断言')
  })
  it('output-style 关闭 coding 段时不注入（随 # 干活 门控）', () => {
    const sp = buildSystemPrompt('/tmp', undefined, undefined, undefined, undefined,
      { name: 'x', description: '', prompt: 'P', keepCodingInstructions: false } as any)
    expect(sp).not.toContain('别把假设当事实断言')
  })
})

describe('响应语言锁定（language）', () => {
  it('languageSection 命令模型始终用指定语言', () => {
    const s = languageSection('日本語')
    expect(s.startsWith('# 语言')).toBe(true)
    expect(s).toContain('始终用「日本語」回复')
  })
  it('设了 language → buildSystemPrompt 注入语言段', () => {
    const sp = buildSystemPrompt('/tmp', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'English')
    expect(sp).toContain('# 语言')
    expect(sp).toContain('始终用「English」回复')
  })
  it('未设 language → 不注入', () => {
    const sp = buildSystemPrompt('/tmp')
    expect(sp).not.toContain('# 语言')
  })
  it('空白 language → 不注入（视同未设）', () => {
    const sp = buildSystemPrompt('/tmp', undefined, undefined, undefined, undefined, undefined, undefined, undefined, '   ')
    expect(sp).not.toContain('# 语言')
  })
})
