import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseHashMemory, appendMemoryBullet, resolveMemoryTarget, writeHashMemory,
} from '../src/tui/hashMemory.js'

describe('parseHashMemory：识别行首 # 快速记忆', () => {
  it('# 后接文本 → 返回去空白的记忆文本', () => {
    expect(parseHashMemory('# 用 pnpm 不用 npm')).toBe('用 pnpm 不用 npm')
  })
  it('# 与文本间多空格 → trim', () => {
    expect(parseHashMemory('#    偏好原生 CSS  ')).toBe('偏好原生 CSS')
  })
  it('# 紧跟文本无空格也算（触发在行首 #）', () => {
    expect(parseHashMemory('#note')).toBe('note')
  })
  it('非 # 开头 → null', () => {
    expect(parseHashMemory('普通消息')).toBeNull()
    expect(parseHashMemory('/model')).toBeNull()
  })
  it('前导空白后再 # 不触发（必须严格行首，避免误伤 markdown/代码）', () => {
    expect(parseHashMemory('  # 缩进的井号')).toBeNull()
  })
  it('只有 # 或 # 加空白 → null（无内容不触发）', () => {
    expect(parseHashMemory('#')).toBeNull()
    expect(parseHashMemory('#   ')).toBeNull()
  })
})

describe('appendMemoryBullet：把记忆追加为一行 bullet', () => {
  it('空文件 → 仅一行 bullet + 结尾换行', () => {
    expect(appendMemoryBullet('', '用 pnpm')).toBe('- 用 pnpm\n')
  })
  it('已有内容无结尾换行 → 补换行再追加', () => {
    expect(appendMemoryBullet('# 项目记忆', '偏好原生 CSS')).toBe('# 项目记忆\n- 偏好原生 CSS\n')
  })
  it('已有内容带结尾换行 → 直接追加', () => {
    expect(appendMemoryBullet('- 旧一条\n', '新一条')).toBe('- 旧一条\n- 新一条\n')
  })
  it('已有内容多个结尾换行 → 归一为单换行再追加（不产空 bullet 前的空行堆积）', () => {
    expect(appendMemoryBullet('- 旧\n\n\n', '新')).toBe('- 旧\n- 新\n')
  })
  it('记忆文本首尾空白已由 parseHashMemory trim；本函数按原样包 bullet', () => {
    expect(appendMemoryBullet('', 'a b')).toBe('- a b\n')
  })
})

describe('resolveMemoryTarget：作用域 → 文件路径', () => {
  it('project → <cwd>/DEEPCODE.md', () => {
    expect(resolveMemoryTarget('project', '/proj', '/home/u')).toBe(path.join('/proj', 'DEEPCODE.md'))
  })
  it('global → <home>/.deepcode/DEEPCODE.md', () => {
    expect(resolveMemoryTarget('global', '/proj', '/home/u')).toBe(path.join('/home/u', '.deepcode', 'DEEPCODE.md'))
  })
})

describe('writeHashMemory：追加 bullet 到目标文件（真实 fs）', () => {
  it('project：文件不存在 → 新建并写入 bullet，返回路径', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-hashmem-'))
    const p = writeHashMemory('project', '用 pnpm', dir, path.join(dir, 'home'))
    expect(p).toBe(path.join(dir, 'DEEPCODE.md'))
    expect(fs.readFileSync(p, 'utf8')).toBe('- 用 pnpm\n')
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it('project：已有内容 → 追加而非覆盖', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-hashmem-'))
    fs.writeFileSync(path.join(dir, 'DEEPCODE.md'), '# 项目\n- 旧\n')
    const p = writeHashMemory('project', '新', dir, path.join(dir, 'home'))
    expect(fs.readFileSync(p, 'utf8')).toBe('# 项目\n- 旧\n- 新\n')
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it('global：自动创建 ~/.deepcode 目录后写入', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-hashmem-'))
    const home = path.join(dir, 'home')  // 不存在的 home
    const p = writeHashMemory('global', '偏好原生 CSS', dir, home)
    expect(p).toBe(path.join(home, '.deepcode', 'DEEPCODE.md'))
    expect(fs.readFileSync(p, 'utf8')).toBe('- 偏好原生 CSS\n')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
