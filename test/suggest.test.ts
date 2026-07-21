// test/suggest.test.ts —— skills 补全新增用例（与 tui.suggest.test.tsx 互补）
import { describe, it, expect } from 'vitest'
import { computeSuggestions, firstSentence, truncateToWidth, layoutDescription, computeLineWindow } from '../src/tui/suggest.js'

describe('computeSuggestions skills 补全', () => {
  it('/ 补全合并 skill 名（userInvocable），与 customCommand 去重，不列 userInvocable=false', () => {
    const out = computeSuggestions('/gr', {
      cwd: process.cwd(), customCommands: new Map(),
      skills: [{ name: 'greet', userInvocable: true }, { name: 'secret', userInvocable: false }],
    })
    expect(out.map(s => s.value)).toContain('/greet')
    expect(out.map(s => s.value)).not.toContain('/secret')
  })

  it('skill 候选 hint 为真实描述', () => {
    const out = computeSuggestions('/gr', {
      cwd: process.cwd(), customCommands: new Map(),
      skills: [{ name: 'greet', userInvocable: true, description: '打招呼技能' }],
    })
    expect(out.find(s => s.value === '/greet')?.hint).toBe('打招呼技能')
  })

  it('命令与同名技能去重（命令优先，显首行描述+来源后缀，命令/技能分离）', () => {
    const out = computeSuggestions('/de', {
      cwd: process.cwd(), customCommands: new Map([['deploy', { template: '部署应用', source: 'user' as const }]]),
      skills: [{ name: 'deploy', userInvocable: true, description: '部署技能' }],
    })
    const deploys = out.filter(s => s.value === '/deploy')
    expect(deploys.length).toBe(1)
    expect(deploys[0].hint).toBe('部署应用 (用户)') // 命令以命令身份展示，非技能
  })

  it('无 skills 时行为与原来一致（无 skills 参数）', () => {
    const out = computeSuggestions('/mo', {
      cwd: process.cwd(), customCommands: new Map(),
    })
    expect(out.map(s => s.value)).toContain('/model')
  })

  it('子串模糊匹配：命令名中段也能命中（/text → /context）', () => {
    const out = computeSuggestions('/text', { cwd: process.cwd(), customCommands: new Map() })
    expect(out.map(s => s.value)).toContain('/context')
  })

  it('输入恰为某命令全名时隐藏菜单（回车直接提交）', () => {
    const out = computeSuggestions('/model', { cwd: process.cwd(), customCommands: new Map() })
    expect(out).toEqual([])
  })

  it('自定义命令 hint = 首行描述 + 来源后缀 (用户)/(项目)', () => {
    const out = computeSuggestions('/', {
      cwd: process.cwd(),
      customCommands: new Map([
        ['deployu', { template: '用户命令描述\n更多内容', source: 'user' as const }],
        ['deployp', { template: '项目命令描述', source: 'project' as const }],
      ]),
    })
    expect(out.find(s => s.value === '/deployu')?.hint).toBe('用户命令描述 (用户)')
    expect(out.find(s => s.value === '/deployp')?.hint).toBe('项目命令描述 (项目)')
  })

  it('命令描述为空时 hint 仅来源后缀', () => {
    const out = computeSuggestions('/', {
      cwd: process.cwd(),
      customCommands: new Map([['empty', { template: '   ', source: 'user' as const }]]),
    })
    expect(out.find(s => s.value === '/empty')?.hint).toBe('(用户)')
  })

  it('桶序：内置 → 用户自定义 → 项目自定义 → 技能', () => {
    const out = computeSuggestions('/', {
      cwd: process.cwd(),
      customCommands: new Map([
        ['zuser', { template: 'x', source: 'user' as const }],
        ['aproj', { template: 'x', source: 'project' as const }],
      ]),
      skills: [{ name: 'askill', userInvocable: true, description: 'd' }],
    })
    const vals = out.map(s => s.value)
    const iModel = vals.indexOf('/model')      // 内置
    const iUser = vals.indexOf('/zuser')       // 用户自定义
    const iProj = vals.indexOf('/aproj')       // 项目自定义
    const iSkill = vals.indexOf('/askill')     // 技能
    expect(iModel).toBeLessThan(iUser)
    expect(iUser).toBeLessThan(iProj)
    expect(iProj).toBeLessThan(iSkill)
  })

  it('前缀过滤后仍返回全部匹配（不再硬顶 8 条）', () => {
    const skills = Array.from({ length: 12 }, (_, i) => ({ name: `foo${i}`, userInvocable: true, description: 'd' }))
    const out = computeSuggestions('/foo', { cwd: process.cwd(), customCommands: new Map(), skills })
    expect(out.length).toBe(12)
  })
})

describe('firstSentence 菜单简写', () => {
  it('取到第一个句末标点（中文句号）', () => {
    expect(firstSentence('第一句。第二句。第三句')).toBe('第一句。')
  })
  it('英文句点', () => {
    expect(firstSentence('Does X. Then Y. And Z.')).toBe('Does X.')
  })
  it('无句末标点 → 折叠空白后整段', () => {
    expect(firstSentence('one   two\nthree')).toBe('one two three')
  })
})

describe('truncateToWidth 显示宽度截断', () => {
  it('放得下不截', () => {
    expect(truncateToWidth('abc', 10)).toBe('abc')
  })
  it('英文超宽 → 截断加省略号（预留 1 列）', () => {
    expect(truncateToWidth('abcdef', 4)).toBe('abc…')
  })
  it('中文按 2 列计', () => {
    // 「中文字」= 6 列；maxCols=5 → 留 1 列给省略号，只放得下 2 个中文字（4 列）
    expect(truncateToWidth('中文字', 5)).toBe('中文…')
  })
})

describe('layoutDescription 最多两行', () => {
  it('放得下 avail1 → 单行', () => {
    expect(layoutDescription('short desc', 20, 20)).toEqual({ line1: 'short desc', line2: '' })
  })
  it('超宽 → 第一行按词边界拆、第二行截断', () => {
    const r = layoutDescription('alpha beta gamma delta', 12, 12)
    expect(r.line1).toBe('alpha beta') // 硬截到 12 列是 "alpha beta g"，回退到最后空格 → "alpha beta"
    expect(r.line2).toBe('gamma delta')
  })
  it('avail1<=0 → 空', () => {
    expect(layoutDescription('x', 0, 10)).toEqual({ line1: '', line2: '' })
  })
})

describe('computeLineWindow 行预算开窗', () => {
  it('全部放得下 → 全窗', () => {
    expect(computeLineWindow([1, 1, 1], 0, 6)).toEqual({ start: 0, end: 3 })
  })
  it('两行项按行高占预算（预算 4，全 2 行项 → 只容 2 项）', () => {
    const r = computeLineWindow([2, 2, 2, 2], 0, 4)
    expect(r.end - r.start).toBe(2)
  })
  it('选中项始终在窗口内', () => {
    const heights = Array(20).fill(1)
    const r = computeLineWindow(heights, 15, 6)
    expect(15).toBeGreaterThanOrEqual(r.start)
    expect(15).toBeLessThan(r.end)
    expect(r.end - r.start).toBe(6)
  })
})
