// test/loopFixture.test.ts
//
// 闭环回归夹具的守卫。这份夹具的价值全靠「种子里的缺陷还在」——而它失效时是**静默的**：
// 种子被人动过、缺陷消失，夹具照样跑得动，只是永远逼不出 FAIL，看起来像「闭环没问题」。
// 今天一整天修的就是这一类「尺子悄悄不量了」的问题，所以这里必须有守卫。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FIX = path.join(process.cwd(), 'bench', 'loop-fixture')

describe('闭环夹具的种子未被改动', () => {
  it('每个文件的 SHA256 与冻结清单一致', () => {
    const manifest = fs.readFileSync(path.join(FIX, 'MANIFEST.sha256'), 'utf8').trim().split('\n')
    expect(manifest.length, '清单是空的').toBeGreaterThan(10)
    const bad: string[] = []
    for (const line of manifest) {
      // shasum 输出格式：`<hash>  ./相对路径`
      const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line)
      expect(m, `清单行格式不对：${line}`).toBeTruthy()
      const [, want, rel] = m!
      const p = path.join(FIX, 'seed', rel)
      if (!fs.existsSync(p)) { bad.push(`${rel}: 文件不存在`); continue }
      const got = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      if (got !== want) bad.push(`${rel}: 内容已改变`)
    }
    expect(bad, `种子已被改动，缺陷可能已消失，夹具不再可信：\n${bad.join('\n')}`).toEqual([])
  })

  it('种子里没有 node_modules / dist —— 它们不该进仓库，也会让清单失效', () => {
    for (const d of ['node_modules', 'dist']) {
      expect(fs.existsSync(path.join(FIX, 'seed', d)), `seed/${d} 不该存在`).toBe(false)
    }
  })

  it('任务书里保留着那两条会踩中遗留缺陷的要求', () => {
    // 去掉任何一条，验证者就没有判据去检查 stderr 与 `-`，夹具随之失效。
    const task = fs.readFileSync(path.join(FIX, 'task.md'), 'utf8')
    expect(task, '缺少「- 表示 stdin」这条要求').toMatch(/传 `-` 时从 stdin 读取/)
    expect(task, '缺少「错误走 stderr、退出码 2」这条要求').toMatch(/stderr 打一行说明，退出码 2/)
  })

  it('README 记着已知缺陷与「四种结果都要如实记」的纪律', () => {
    const readme = fs.readFileSync(path.join(FIX, 'README.md'), 'utf8')
    expect(readme).toContain('L3-03')          // 遗留缺陷的冻结考卷编号
    expect(readme).toContain('L2-15')
    expect(readme).toMatch(/四种结果都要如实记/)
    expect(readme).toMatch(/不是有效性证据/)   // n=1 的边界必须写着
  })
})
