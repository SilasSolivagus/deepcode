// test/inputbox.image.test.tsx — Task 7: InputBox 图片抓取
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InputBox } from '../src/tui/components/InputBox.js'

describe('InputBox image capture', () => {
  it('拖入图片文件路径 → [Image #N] + 附件携带 base64', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ib-'))
    const f = path.join(dir, 'shot.png')
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    // ⚠️ 三处等待全部条件化。此前只有最后一步用了 waitFor，前面两个固定 sleep 仍在：
    // 20ms 在全量并发叠机器负载下不够用，回车会赶在路径处理完之前到达，表现为 onSubmit
    // 零次调用——与本用例逻辑无关的偶发失败。实测 6 次全量挂 3 次，这是其中一种。
    // ⚠️ 挂载等待没法条件化：lastFrame() 从第一帧起就非空（是个边框），任何基于它的条件
    // 都会立刻通过、一个 tick 都不让，于是 write 打在还没注册 useInput 的组件上、输入整个丢失。
    // 故这里保留显式让出事件循环，且多让几次以抗并发负载。
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
    stdin.write(`'${f}'`)            // 终端拖文件粘的带引号路径
    // 写入之后的一切都可观测：输入框把图片路径**就地替换成占位符**，等它出现即可。
    // 等 shot.png 是错的——画面里永远不会有路径本身。
    await vi.waitFor(() => expect(lastFrame()).toContain('[Image #1]'))
    stdin.write('\r')
    // 轮询而非固定 sleep：提交要过「异步读文件 + ink 渲染周期」，固定 20ms 在全量并发
    // 叠机器负载时不够用，表现为与本用例逻辑无关的偶发 0 次调用。
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const [text, attachments] = onSubmit.mock.calls[0]
    expect(text).toMatch(/\[Image #1\]/)
    expect(attachments[0]).toMatchObject({ type: 'image', mime: 'image/png', source: 'file' })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
