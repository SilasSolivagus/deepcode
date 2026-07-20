// test/useChat.reloadSkills.test.ts —— Task4：/reload-skills 运行时热加载技能
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatCore } from '../src/tui/useChat.js'

let proj: string
let sessionDir: string
beforeEach(() => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-reload-proj-'))
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-reload-session-'))
})
afterEach(() => {
  fs.rmSync(proj, { recursive: true, force: true })
  fs.rmSync(sessionDir, { recursive: true, force: true })
})

describe('/reload-skills', () => {
  it('重扫盘上新增技能', async () => {
    fs.mkdirSync(path.join(proj, '.deepcode', 'skills', 'foo'), { recursive: true })
    fs.writeFileSync(path.join(proj, '.deepcode', 'skills', 'foo', 'SKILL.md'),
      '---\nname: foo\ndescription: foo skill\n---\nbody')

    const core = createChatCore({ client: {} as any, yolo: true, cwd: proj, sessionDir, onState: () => {} })
    expect(core.skills.some(s => s.name === 'foo')).toBe(true)

    // 运行中再加一个技能目录
    fs.mkdirSync(path.join(proj, '.deepcode', 'skills', 'bar'), { recursive: true })
    fs.writeFileSync(path.join(proj, '.deepcode', 'skills', 'bar', 'SKILL.md'),
      '---\nname: bar\ndescription: bar skill\n---\nbody')
    expect(core.skills.some(s => s.name === 'bar')).toBe(false) // 尚未重载

    await core.send('/reload-skills')
    expect(core.skills.some(s => s.name === 'bar')).toBe(true) // 重载后可见
    core.dispose()
  })
})
