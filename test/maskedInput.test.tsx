import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { MaskedInput } from '../src/tui/components/MaskedInput.js'

const wait = (ms = 60) => new Promise(r => setTimeout(r, ms))

// 校准发现（详见任务报告）：ink-testing-library 的 render() 是同步调用，但 useInput 内部
// 挂载 setRawMode/事件监听的 useEffect 要等下一轮事件循环才真正生效——render() 后立即同步
// stdin.write() 会在监听器就绪前发出，直接丢失。真机终端不存在这个时序缝隙（raw mode 早已开
// 着），纯属测试环境的时序假象。每个 test 在 render() 后先 `await wait(0)` 让 effect 落地，
// 再开始 stdin.write，避免第一次按键静默丢失（曾用临时 console.error 打印收到的 (input,key)
// 核实：丢失的写入确实从未到达 useInput 回调）。
describe('MaskedInput', () => {
  it('masked 只显 •，不回显明文', async () => {
    const { stdin, lastFrame } = render(<MaskedInput masked onSubmit={() => {}} />)
    await wait(0)
    stdin.write('sk-secret'); await wait()
    expect(lastFrame()).not.toContain('sk-secret')
    expect(lastFrame()).toContain('•')
  })
  it('粘贴带尾换行 → 不提交，只进值', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<MaskedInput masked onSubmit={onSubmit} />)
    await wait(0)
    stdin.write('sk-pasted-key\r'); await wait()   // 粘贴含 \r
    expect(onSubmit).not.toHaveBeenCalled()         // 粘贴的 \r 不触发提交
    stdin.write('\r'); await wait()                 // 用户真按 Enter
    expect(onSubmit).toHaveBeenCalledWith('sk-pasted-key')
  })
  it('多行粘贴取第一行', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<MaskedInput masked onSubmit={onSubmit} />)
    await wait(0)
    stdin.write('line1\nline2\nline3'); await wait()
    stdin.write('\r'); await wait()
    expect(onSubmit).toHaveBeenCalledWith('line1')
  })
  it('bracketed-paste 标记被剥', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<MaskedInput masked onSubmit={onSubmit} />)
    await wait(0)
    stdin.write('\x1b[200~sk-x\x1b[201~'); await wait()
    stdin.write('\r'); await wait()
    expect(onSubmit).toHaveBeenCalledWith('sk-x')
  })
  it('Esc → onCancel', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(<MaskedInput masked onSubmit={() => {}} onCancel={onCancel} />)
    await wait(0)
    stdin.write('\x1b'); await wait()
    expect(onCancel).toHaveBeenCalled()
  })
})
