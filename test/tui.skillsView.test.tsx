// test/tui.skillsView.test.tsx —— /skills 四态交互编辑器
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { SkillsView } from '../src/tui/SkillsView.js'
import type { SkillDefinition } from '../src/skillsLoader.js'

const delay = async (ms = 5) => {
  // ⚠️ 两类等待必须都覆盖，缺一不可：
  // ① 有些调用点等的是**源码里的真实定时器**（如 InputBox 的 PASTE_COALESCE_MS=40 去抖窗口），
  //    这类必须让真实时间流逝——只让 tick 的话去抖压根不触发。
  // ② 有些等的是**异步活干完**（ink 挂载、useInput 注册、文件读取），这类靠固定时长不可靠：
  //    到点就走、不随负载自适应，全量并发下按键会打在还没监听的组件上。
  // 故：先睡满调用点要求的时长，再多让 8 个事件循环边界（每次在负载下都被调度器自然拉长）。
  if (ms > 0) await new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1))
}

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
