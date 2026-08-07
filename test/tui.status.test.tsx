// test/tui.status.test.tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Banner } from '../src/tui/components/Banner.js'
import { SelectList } from '../src/tui/components/SelectList.js'

describe('Banner', () => {
  it('显示双列欢迎框：logo 名称、欢迎语、上手提示、cwd 与模型', () => {
    const f = render(<Banner cwd="/tmp/demo" model="deepseek-v4-flash" provider="DeepSeek" />).lastFrame()!
    expect(f).toContain('✦ deepcode')
    expect(f).toContain('DeepSeek')      // provider 展示名由调用方传入（展示组件不读磁盘）
    expect(f).toContain('欢迎')          // 欢迎回来/欢迎使用
    expect(f).toContain('上手')          // 右列上手提示
    expect(f).toContain('/help')
    expect(f).toContain('/tmp/demo')     // cwd（无 cwd: 标签）
    expect(f).toContain('deepseek-v4-flash')
  })
})

const delay = async (ms = 0) => {
  // ⚠️ 两类等待必须都覆盖，缺一不可：
  // ① 有些调用点等的是**源码里的真实定时器**（如 InputBox 的 PASTE_COALESCE_MS=40 去抖窗口），
  //    这类必须让真实时间流逝——只让 tick 的话去抖压根不触发。
  // ② 有些等的是**异步活干完**（ink 挂载、useInput 注册、文件读取），这类靠固定时长不可靠：
  //    到点就走、不随负载自适应，全量并发下按键会打在还没监听的组件上。
  // 故：先睡满调用点要求的时长，再多让 8 个事件循环边界（每次在负载下都被调度器自然拉长）。
  if (ms > 0) await new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1))
}

describe('SelectList', () => {
  it('↑↓ 移动选中，Enter 回调，Esc 取消', async () => {
    const onPick = vi.fn(); const onCancel = vi.fn()
    const r = render(<SelectList items={['会话A', '会话B']} onPick={onPick} onCancel={onCancel} />)
    // ⚠️ 挂载与按键之间的等待没法条件化（帧从第一帧起就非空），故保留显式让出事件循环、
    // 且多让几次以抗并发负载；最终断言改成条件轮询。原来 delay() 默认只让 1 个 tick，
    // 全量并发下不够，键打在还没监听的组件上——实测 6 次全量挂 3 次，这是其中一种。
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) }
    await settle()
    r.stdin.write('\x1b[B')
    await settle()
    r.stdin.write('\r')
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith(1))
    const r2 = render(<SelectList items={['x']} onPick={onPick} onCancel={onCancel} />)
    await settle()
    r2.stdin.write('\x1b')
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled())
  })
})
