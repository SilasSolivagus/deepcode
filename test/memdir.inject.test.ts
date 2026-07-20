// test/memdir.inject.test.ts
// Task 5：验证 loadMemoryPrompt 优先注入 .index.md + 最近尾巴，loadGlobalMemoryPrompt 超预算走 .index.md
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadMemoryPrompt, loadGlobalMemoryPrompt } from '../src/memdir/memdir.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('loadMemoryPrompt', () => {
  it('有 .index.md 时优先注入它，并带查阅指令', () => {
    fs.writeFileSync(path.join(dir, '.index.md'), '## 偏好\n- project:a.md: 不喜欢 tailwind')
    const out = loadMemoryPrompt(dir)
    expect(out).toContain('不喜欢 tailwind')
    expect(out).toContain('SearchMemory')
  })
  it('.index.md 存在时，比它更新的记忆进「最近」尾巴，更旧的不进', () => {
    fs.writeFileSync(path.join(dir, '.index.md'), '## 索引\n- old')
    const old = Date.now() - 60_000
    fs.utimesSync(path.join(dir, '.index.md'), new Date(old), new Date(old)) // index mtime = cutoff
    fs.writeFileSync(path.join(dir, 'fresh.md'), '---\ndescription: 新条目\n---\nbody')
    // fresh.md 默认 mtime = 现在 > cutoff（应被收进「最近」）
    fs.writeFileSync(path.join(dir, 'stale.md'), '---\ndescription: 旧条目\n---\nbody')
    fs.utimesSync(path.join(dir, 'stale.md'), new Date(old - 60_000), new Date(old - 60_000)) // < cutoff（不应被收进）
    const out = loadMemoryPrompt(dir)
    expect(out).toContain('最近')
    expect(out).toContain('fresh.md')
    expect(out).not.toContain('stale.md')
  })
  it('.index.md 存在、>30 条更新记忆时，「最近」尾巴取 mtime 最新的 30 条而非目录序前 30 条', () => {
    fs.writeFileSync(path.join(dir, '.index.md'), '## 索引\n- old')
    const cutoff = Date.now() - 3_600_000
    fs.utimesSync(path.join(dir, '.index.md'), new Date(cutoff), new Date(cutoff))
    // 35 个候选文件，全部新于 cutoff，mtime 依次递增（f34 最新）；文件名刻意反向，
    // 让「目录序」与「mtime 序」冲突——旧的 break-at-30 实现会按目录序（f00 最先）截断，
    // 而正确实现按 mtime 降序应保留最新的 f05..f34。
    for (let i = 0; i < 35; i++) {
      const n = `f${String(i).padStart(2, '0')}.md`
      fs.writeFileSync(path.join(dir, n), `---\ndescription: 条目${i}\n---\nbody`)
      fs.utimesSync(path.join(dir, n), new Date(cutoff + (i + 1) * 1000), new Date(cutoff + (i + 1) * 1000))
    }
    const out = loadMemoryPrompt(dir)
    // 最新的（f34）必须在场
    expect(out).toContain('f34.md')
    // 最旧的 5 个（f00..f04，超出 30 条上限）不应出现
    expect(out).not.toContain('f00.md')
    expect(out).not.toContain('f04.md')
  })
  it('无 .index.md 时回退 MEMORY.md（零回归）', () => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory Index\n- [x](x.md) — hook')
    const out = loadMemoryPrompt(dir)
    expect(out).toContain('hook')
  })
})

describe('loadGlobalMemoryPrompt', () => {
  it('超预算时优先注入全局 .index.md 主题索引', () => {
    fs.writeFileSync(path.join(dir, 'big.md'), '---\nx: 1\n---\n' + 'a'.repeat(5000))
    fs.writeFileSync(path.join(dir, '.index.md'), '## 全局主题\n- big.md: 一大段')
    const out = loadGlobalMemoryPrompt(dir, 100) // 预算很小，强制超预算
    expect(out).toContain('全局主题')
  })
})
