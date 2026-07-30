// P0 第一步：headless 的 thinking 与 headlessMaxTurns 变成可配开关。
//
// 背景：headless 是跑 SWE-bench 与一切程序化调用的路径，此前 thinking 硬编码 false、
// headlessMaxTurns 从不覆盖（沿用 loop.ts 的 80，撞上限直接 seal 退出无收尾降级）。
// 对照实验的结论认为这是自动化路径 flaky 的一个来源，但是否划算须 A/B 验证——
// 故做成开关且**默认保持既有行为**，否则基线与处理组无法区分。
//
// 这些用例锁三件事：默认不变、能被 user 层打开、project 层不得设置（成本面）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadLayeredSettings } from '../src/settingsLayers.js'

/** 造一个带 user 层与（可选）project 层设置的临时工程目录。 */
function fixture(user: object, project?: object): string {
  const home = mkdtempSync(path.join(tmpdir(), 'dc-p0-home-'))
  const proj = mkdtempSync(path.join(tmpdir(), 'dc-p0-proj-'))
  mkdirSync(path.join(home, '.deepcode'), { recursive: true })
  writeFileSync(path.join(home, '.deepcode', 'settings.json'), JSON.stringify(user))
  if (project) {
    mkdirSync(path.join(proj, '.deepcode'), { recursive: true })
    writeFileSync(path.join(proj, '.deepcode', 'settings.json'), JSON.stringify(project))
  }
  process.env.HOME = home
  return proj
}

describe('headless thinking / headlessMaxTurns 开关', () => {
  // fixture() 改写 process.env.HOME 让 os.homedir() 指向临时目录（settingsLayers.ts 的 user 层
  // 靠它定位）。同 worker 里后续测试文件全共享一个进程，不还原会让本文件之后跑的任何测试
  // 都读到这里最后一次留下的临时 HOME——这正是本仓库偶发红的一个来源，必须每例后复原。
  let origHome: string | undefined
  beforeEach(() => { origHome = process.env.HOME })
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
  })

  it('默认：两者均为 undefined（headless 维持 thinking=false、沿用 loop 的 80）', () => {
    const proj = fixture({})
    const s = loadLayeredSettings(proj).settings
    expect(s.headlessThinking).toBeUndefined()
    expect(s.headlessMaxTurns).toBeUndefined()
  })

  it('user 层可打开 thinking 并调高 headlessMaxTurns', () => {
    const proj = fixture({ headlessThinking: true, headlessMaxTurns: 120 })
    const s = loadLayeredSettings(proj).settings
    expect(s.headlessThinking).toBe(true)
    expect(s.headlessMaxTurns).toBe(120)
  })

  it('project 层设置被剥离：不可信仓库不得拉高步数或悄悄开思考（成本面）', () => {
    const proj = fixture({}, { headlessThinking: true, headlessMaxTurns: 9999 })
    const s = loadLayeredSettings(proj).settings
    expect(s.headlessThinking).toBeUndefined()
    expect(s.headlessMaxTurns).toBeUndefined()
  })

  it('非法值被忽略：headlessMaxTurns 非正数或非数字一律回落默认', () => {
    for (const bad of [0, -1, '120', null]) {
      const proj = fixture({ headlessMaxTurns: bad })
      expect(loadLayeredSettings(proj).settings.headlessMaxTurns).toBeUndefined()
    }
  })
})
