import { describe, it, expect } from 'vitest'
import { BUILTIN_AGENTS, GLOBAL_SUBAGENT_DENY, resolveAgentTools } from '../src/tools/agentTypes.js'

const def = () => BUILTIN_AGENTS.find(a => a.agentType === 'verification')!

// 只用到 name 字段，够 resolveAgentTools 过滤了
const pool = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch']
  .map(name => ({ name })) as any

describe('verification 子代理已注册', () => {
  it('存在于 BUILTIN_AGENTS', () => {
    expect(def()).toBeDefined()
  })

  it('model 继承父级当前模型', () => {
    expect(def().model).toBe('inherit')
  })

  it('禁改项目文件：Edit/Write/NotebookEdit/Agent 全部被 deny', () => {
    expect(def().disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit', 'Agent'])
  })

  it('Bash 必须保留——验证者靠它往 /tmp 写一次性脚本', () => {
    const names = resolveAgentTools(def(), pool, GLOBAL_SUBAGENT_DENY).map((t: any) => t.name)
    expect(names).toContain('Bash')
    expect(names).toContain('Read')
  })

  it('解析后的工具集里真的没有写文件的工具', () => {
    const names = resolveAgentTools(def(), pool, GLOBAL_SUBAGENT_DENY).map((t: any) => t.name)
    for (const denied of ['Edit', 'Write', 'NotebookEdit', 'Agent']) {
      expect(names, `${denied} 不该出现`).not.toContain(denied)
    }
  })
})

describe('verification 系统提示词保留了 spec §5.2 的十条机关', () => {
  const sp = () => def().getSystemPrompt()

  it('① 开篇定调「试图弄坏它」', () => {
    expect(sp()).toContain('试图弄坏它')
  })
  it('② 点名两种失败模式', () => {
    expect(sp()).toContain('回避验证')
    expect(sp()).toContain('前 80%')
  })
  it('③ 禁止修改项目、但允许写 /tmp', () => {
    expect(sp()).toContain('禁止')
    expect(sp()).toContain('/tmp')
  })
  it('④ 必答格式的两个标记逐字固定（判定器要靠它们做正则）', () => {
    expect(sp()).toContain('**跑了什么命令：**')
    expect(sp()).toContain('**看到什么输出：**')
  })
  it('⑤ 判 PASS 必须附对抗性探针', () => {
    expect(sp()).toContain('对抗性探针')
  })
  it('⑥ 测试套件结果是背景不是证据', () => {
    expect(sp()).toContain('不是证据')
  })
  it('⑦ 判 FAIL 前的反向检查', () => {
    expect(sp()).toContain('有意为之')
  })
  it('⑧ 识别自己的托词', () => {
    expect(sp()).toContain('读不是验证')
  })
  it('⑨ 末行三种 verdict 都在，且是判定器要匹配的字面量', () => {
    for (const v of ['VERDICT: PASS', 'VERDICT: FAIL', 'VERDICT: PARTIAL']) {
      expect(sp()).toContain(v)
    }
  })
  it('⑩ PARTIAL 只给环境限制', () => {
    expect(sp()).toContain('环境限制')
  })
  it('要求读项目的构建/测试命令来源', () => {
    expect(sp()).toContain('package.json')
  })
})
