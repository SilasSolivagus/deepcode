import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import React from 'react'

// 反色断言需要 chalk 判定「支持颜色」；本进程非真 TTY（vitest 子进程/CI），chalk 会自动降级到
// level 0 直接吐纯文本。ink（连同其内部私有 chalk 副本）在 'ink-testing-library' 首次被 import
// 时就完成 level 判定，所以必须先设 FORCE_COLOR 再动态 import，静态 import 会被 ESM 提升到更早执行。
let render: typeof import('ink-testing-library')['render']
let InputBox: typeof import('../src/tui/components/InputBox.js')['InputBox']
let prevForceColor: string | undefined

beforeAll(async () => {
  prevForceColor = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '1'
  ;({ render } = await import('ink-testing-library'))
  ;({ InputBox } = await import('../src/tui/components/InputBox.js'))
})

afterAll(() => {
  if (prevForceColor === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = prevForceColor
})

const tick = () => new Promise(r => setTimeout(r, 20))

describe('InputBox cursor — 打字与渲染', () => {
  it('顺序打字 → 提交完整内容（零回归）', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick()
    stdin.write('hello'); await tick()
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('hello', expect.any(Array))
  })
  it('Ctrl+J（\\n）在光标处插入换行而不提交，可写多行 prompt', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick()
    stdin.write('ab'); await tick()
    stdin.write('\n'); await tick()            // Ctrl+J：插入换行，不提交
    expect(onSubmit).not.toHaveBeenCalled()
    stdin.write('cd'); await tick()
    stdin.write('\r'); await tick()            // Enter：提交
    expect(onSubmit).toHaveBeenCalledWith('ab\ncd', expect.any(Array))
  })
  it('渲染含字素反色光标（末尾反色空格）', async () => {
    const { stdin, lastFrame } = render(<InputBox onSubmit={() => {}} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick()
    stdin.write('hi'); await tick()
    // 反色由 <Text inverse> 产出 ANSI 反显码；至少确认内容出现且带反显序列
    expect(lastFrame()).toContain('hi')
    expect(lastFrame()).toMatch(/\x1b\[7m/) // SGR inverse
  })
  it('空输入也显示反色光标（一个字没打时真光标已隐藏，全靠反色块）', async () => {
    const { lastFrame } = render(<InputBox onSubmit={() => {}} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick()
    expect(lastFrame()).toMatch(/\x1b\[7m/)          // value==='' 也要有反色光标
    expect(lastFrame()).toContain('随便问点什么')     // 提示仍在
  })
  it('光标闪烁：约 530ms 后反色相位翻转（off→无反色→再翻回）', async () => {
    vi.useFakeTimers()
    try {
      const { lastFrame } = render(<InputBox onSubmit={() => {}} onInterrupt={() => {}} history={[]} busy={false} />)
      expect(lastFrame()).toMatch(/\x1b\[7m/)         // 初始 cursorOn=true → 有反色
      await vi.advanceTimersByTimeAsync(530)
      expect(lastFrame()).not.toMatch(/\x1b\[7m/)     // off 相位 → 无反色
      await vi.advanceTimersByTimeAsync(530)
      expect(lastFrame()).toMatch(/\x1b\[7m/)         // 再翻回 → 有反色
    } finally {
      vi.useRealTimers()
    }
  })
})

const KEY = {
  left: '\x1b[D', right: '\x1b[C', ctrlLeft: '\x1b[1;5D', ctrlRight: '\x1b[1;5C',
  ctrlA: '\x01', ctrlE: '\x05', altB: '\x1bb', altF: '\x1bf', enter: '\r',
}
describe('InputBox cursor — 移动', () => {
  it('Left 后打字插到中间', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('abc'); await tick()
    stdin.write(KEY.left); await tick()          // 光标到 b|c → ab|c
    stdin.write('X'); await tick()               // abXc
    stdin.write(KEY.enter); await tick()
    expect(onSubmit).toHaveBeenCalledWith('abXc', expect.any(Array))
  })
  it('Ctrl+A 到行首插入', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('abc'); await tick()
    stdin.write(KEY.ctrlA); await tick(); stdin.write('X'); await tick()
    stdin.write(KEY.enter); await tick()
    expect(onSubmit).toHaveBeenCalledWith('Xabc', expect.any(Array))
  })
  it('Ctrl+Left 词移动', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('foo bar'); await tick()
    stdin.write(KEY.ctrlLeft); await tick()      // 到 bar 词首：foo |bar
    stdin.write('X'); await tick()               // foo Xbar
    stdin.write(KEY.enter); await tick()
    expect(onSubmit).toHaveBeenCalledWith('foo Xbar', expect.any(Array))
  })
})

describe('InputBox cursor — 删除', () => {
  it('中间 Backspace 删光标前一字符（\\x7f 在 ink 下是 key.delete，无 modifier → 删前）', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('abc'); await tick()
    stdin.write('\x1b[D'); await tick()     // ab|c
    stdin.write('\x7f'); await tick()        // 删前 b → a|c
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('ac', expect.any(Array))
  })
  it('Alt+Backspace 删前一词', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('foo bar'); await tick()
    stdin.write('\x1b\x7f'); await tick()    // Alt+Backspace（key.delete+meta）→ 删 bar → 'foo '
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('foo ', expect.any(Array))
  })
})

describe('InputBox cursor — emacs 删除', () => {
  it('Ctrl+W 删前一词', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('foo bar'); await tick()
    stdin.write('\x17'); await tick()        // 删 bar → 'foo '
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('foo ', expect.any(Array))
  })
  it('Ctrl+U 删到行首', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('abcdef'); await tick()
    stdin.write('\x1b[D'); stdin.write('\x1b[D'); await tick()   // abcd|ef
    stdin.write('\x15'); await tick()        // 删到首 → 'ef'
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('ef', expect.any(Array))
  })
  it('Ctrl+K 删到行尾', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('abcdef'); await tick()
    stdin.write('\x01'); await tick(); stdin.write('\x1b[C'); stdin.write('\x1b[C'); await tick() // ab|cdef
    stdin.write('\x0b'); await tick()        // 删到尾 → 'ab'
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('ab', expect.any(Array))
  })
  it('Ctrl+D 前向删（ink 下唯一前向删键）', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('abc'); await tick()
    stdin.write('\x01'); await tick()        // Ctrl+A → |abc
    stdin.write('\x04'); await tick()        // Ctrl+D 删后 a → |bc
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('bc', expect.any(Array))
  })
})

describe('InputBox cursor — yank', () => {
  it('Ctrl+W 删词后 Ctrl+Y 粘回', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick(); stdin.write('foo bar'); await tick()
    stdin.write('\x17'); await tick()        // 删 bar → 'foo '，kill ring 顶='bar'
    stdin.write('\x19'); await tick()        // yank → 'foo bar'
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('foo bar', expect.any(Array))
  })
  it('Ctrl+Y 后 Alt+Y 轮换到下一条 kill', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await tick()
    stdin.write('xx'); await tick(); stdin.write('\x17'); await tick()   // kill 'xx' → ring=['xx']
    stdin.write('yy'); await tick(); stdin.write('\x17'); await tick()   // kill 'yy' → ring=['yy','xx']
    stdin.write('\x19'); await tick()    // Ctrl+Y yank 'yy' → value 'yy'
    stdin.write('\x1by'); await tick()   // Alt+Y yank-pop → 'xx'
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('xx', expect.any(Array))
  })
  it('yank 后按 ↑ 历史导航打断 yank-pop 链（Alt+Y 不 splice 旧下标）', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={['oldcmd']} busy={false} />)
    await tick()
    stdin.write('xx'); await tick(); stdin.write('\x17'); await tick()  // ring=['xx'], value=''
    stdin.write('\x19'); await tick()    // Ctrl+Y → value 'xx', region {0,2}
    stdin.write('\x1b[A'); await tick()  // ↑ 历史 → value 'oldcmd'（链应打断）
    stdin.write('\x1by'); await tick()   // Alt+Y → 应 no-op（wasYank=false），value 保持 'oldcmd'
    stdin.write('\r'); await tick()
    expect(onSubmit).toHaveBeenCalledWith('oldcmd', expect.any(Array))
  })
})
