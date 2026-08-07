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

const delay = (ms = 0) => new Promise(res => setTimeout(res, ms))

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
