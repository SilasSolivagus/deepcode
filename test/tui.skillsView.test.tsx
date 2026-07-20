// test/tui.skillsView.test.tsx —— /skills 四态交互编辑器
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { SkillsView } from '../src/tui/SkillsView.js'
import type { SkillDefinition } from '../src/skillsLoader.js'

const delay = (ms = 5) => new Promise(res => setTimeout(res, ms))

const mk = (name: string, description = 'd'): SkillDefinition => ({
  name, description, context: 'inline', userInvocable: true, modelInvocable: true,
  skillDir: '/x', isLegacy: false, priority: 0, body: 'b',
})

describe('SkillsView', () => {
  it('渲染技能名 + token + 默认 on 图标', async () => {
    const r = render(<SkillsView skills={[mk('brainstorm', '头脑风暴')]} overrides={{}} onExit={() => {}} />)
    await delay()
    const f = r.lastFrame()!
    expect(f).toContain('brainstorm')
    expect(f).toContain('tok')
    expect(f).toContain('on')
  })

  it('空技能 → 提示无技能', async () => {
    const r = render(<SkillsView skills={[]} overrides={{}} onExit={() => {}} />)
    await delay()
    expect(r.lastFrame()!).toContain('没有已加载的技能')
  })

  it('enter/space 循环四态 on→name-only→user-invocable-only→off，esc 落盘', async () => {
    const onExit = vi.fn()
    const r = render(<SkillsView skills={[mk('a')]} overrides={{}} onExit={onExit} />)
    await delay()
    r.stdin.write(' ')       // on → name-only
    await delay()
    expect(r.lastFrame()!).toContain('name-only')
    r.stdin.write(' ')       // → user-invocable-only
    await delay()
    expect(r.lastFrame()!).toContain('user-only')
    r.stdin.write(' ')       // → off
    await delay()
    expect(r.lastFrame()!).toContain('off')
    r.stdin.write('\x1b')    // esc
    await delay()
    expect(onExit).toHaveBeenCalledWith({ a: 'off' })
  })

  it('循环回到 on 时 esc 落盘去掉该键（不持久化默认）', async () => {
    const onExit = vi.fn()
    const r = render(<SkillsView skills={[mk('a')]} overrides={{ a: 'off' }} onExit={onExit} />)
    await delay()
    r.stdin.write(' ')       // off → on
    await delay()
    r.stdin.write('\x1b')    // esc
    await delay()
    expect(onExit).toHaveBeenCalledWith({})
  })

  it('大列表 bounded 视口：只渲染窗口内技能 + 上下省略指示（防溢出）', async () => {
    const many = Array.from({ length: 60 }, (_, i) => mk(`skill${String(i).padStart(2, '0')}`))
    const r = render(<SkillsView skills={many} overrides={{}} onExit={() => {}} />)
    await delay()
    const f = r.lastFrame()!
    // 不应渲染全部 60 行（否则溢出）——窗口受限
    const rendered = many.filter(s => f.includes(s.name)).length
    expect(rendered).toBeLessThan(60)
    // 光标在顶部时应有「下面还有 N 个」指示
    expect(f).toContain('下面还有')
  })

  it('输入字符进搜索过滤', async () => {
    const r = render(<SkillsView skills={[mk('brainstorm'), mk('cso')]} overrides={{}} onExit={() => {}} />)
    await delay()
    r.stdin.write('cso')
    await delay()
    const f = r.lastFrame()!
    expect(f).toContain('cso')
    expect(f).not.toContain('brainstorm')
  })
})
