// test/memory.promote.test.ts
// Task 10：存量记忆升格候选（复制不移动，人工确认）
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listPromotionCandidates, promoteCandidate } from '../src/services/memory/promote.js'

describe('存量记忆升格候选', () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pm-'))
    const md = path.join(home, '.deepcode', 'projects', '-repo-a', 'memory')
    fs.mkdirSync(md, { recursive: true })
    fs.writeFileSync(path.join(md, 'pref.md'), '---\ndescription: 不喜欢 tailwind\ntype: user\n---\n正文')
    fs.writeFileSync(path.join(md, 'arch.md'), '---\ndescription: 本项目架构\ntype: project\n---\n正文')
  })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  test('只列 user/feedback 两类（project/reference 不是跨项目候选）', async () => {
    const cs = await listPromotionCandidates(home)
    expect(cs.map(c => c.filename)).toEqual(['pref.md'])
    expect(cs[0].projectKey).toBe('-repo-a')
  })

  test('升格是复制不是移动：源文件保留', async () => {
    const cs = await listPromotionCandidates(home)
    const gdir = path.join(home, '.deepcode', 'memory')
    promoteCandidate(cs[0], gdir)
    expect(fs.existsSync(path.join(gdir, 'pref.md'))).toBe(true)
    expect(fs.existsSync(cs[0].filePath)).toBe(true) // 源保留，可回退
  })

  test('全局已有同名文件时不覆盖', async () => {
    const cs = await listPromotionCandidates(home)
    const gdir = path.join(home, '.deepcode', 'memory')
    fs.mkdirSync(gdir, { recursive: true })
    fs.writeFileSync(path.join(gdir, 'pref.md'), '已有内容')
    const out = promoteCandidate(cs[0], gdir)
    expect(out).toContain('已存在')
    expect(fs.readFileSync(path.join(gdir, 'pref.md'), 'utf8')).toBe('已有内容')
  })

  test('feedback 类型也算候选', async () => {
    const md = path.join(home, '.deepcode', 'projects', '-repo-b', 'memory')
    fs.mkdirSync(md, { recursive: true })
    fs.writeFileSync(path.join(md, 'fb.md'), '---\ndescription: 别用 var\ntype: feedback\n---\n正文')
    const cs = await listPromotionCandidates(home)
    expect(cs.some(c => c.filename === 'fb.md' && c.type === 'feedback')).toBe(true)
  })

  test('子目录候选升格：目标父目录不存在也能成功（回归：曾经只 mkdir globalMemdir 本身，子目录候选 copyFileSync 会 ENOENT）', async () => {
    const md = path.join(home, '.deepcode', 'projects', '-repo-a', 'memory')
    fs.mkdirSync(path.join(md, 'preferences'), { recursive: true })
    fs.writeFileSync(path.join(md, 'preferences', 'tailwind.md'), '---\ndescription: 避开 tailwind\ntype: user\n---\n正文')
    const cs = await listPromotionCandidates(home)
    const c = cs.find(x => x.filename === 'preferences/tailwind.md')
    expect(c).toBeDefined()
    const gdir = path.join(home, '.deepcode', 'memory')
    const out = promoteCandidate(c!, gdir)
    expect(out).toContain('已升格')
    expect(fs.existsSync(path.join(gdir, 'preferences', 'tailwind.md'))).toBe(true)
  })

  test('没有任何项目目录时返回空数组，不抛出', async () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pm-empty-'))
    try {
      await expect(listPromotionCandidates(emptyHome)).resolves.toEqual([])
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true })
    }
  })
})
