import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import React from 'react'

let render: typeof import('ink-testing-library')['render']
let SelectList: typeof import('../src/tui/components/SelectList.js')['SelectList']
let prevForceColor: string | undefined

beforeAll(async () => {
  prevForceColor = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '1'
  ;({ render } = await import('ink-testing-library'))
  ;({ SelectList } = await import('../src/tui/components/SelectList.js'))
})

afterAll(() => {
  if (prevForceColor === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = prevForceColor
})

const tick = () => new Promise(r => setTimeout(r, 20))

describe('SelectList', () => {
  it('选中行用 ❯ 指针（不用整行反色块）', async () => {
    const { lastFrame } = render(
      <SelectList items={['甲', '乙', '丙']} onPick={() => {}} onCancel={() => {}} />,
    )
    await tick()
    const f = lastFrame()!
    expect(f).toContain('❯ 甲')       // idx=0 选中带指针
    expect(f).not.toMatch(/\x1b\[7m/) // 无 SGR inverse 反色块
  })

  it('title 渲染在列表上方', async () => {
    const { lastFrame } = render(
      <SelectList items={['x']} title="选择模型" onPick={() => {}} onCancel={() => {}} />,
    )
    await tick()
    expect(lastFrame()!).toContain('选择模型')
  })

  it('长列表按窗口开窗并显示「还有 N 项」', async () => {
    const items = Array.from({ length: 30 }, (_, i) => `项目${i}`)
    const { lastFrame } = render(
      <SelectList items={items} onPick={() => {}} onCancel={() => {}} />,
    )
    await tick()
    const f = lastFrame()!
    expect(f).toContain('还有')       // 底部有「↓ 还有 N 项」指示
    expect(f).not.toContain('项目29') // 末项被窗口裁掉
  })
})
