// test/headless.maxTurnsFlag.test.ts
import { describe, it, expect } from 'vitest'
import { parseMaxTurns } from '../src/streamJson.js'

describe('parseMaxTurns', () => {
  it('未传时返回 undefined（沿用 settings/默认值）', () => {
    expect(parseMaxTurns(['-p', '任务'])).toBeUndefined()
  })
  it('正整数正常解析', () => {
    expect(parseMaxTurns(['-p', '任务', '--max-turns', '150'])).toBe(150)
    expect(parseMaxTurns(['--max-turns', '1'])).toBe(1)
  })
  it('零、负数、非整数、非数字一律报错', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      expect(() => parseMaxTurns(['--max-turns', bad]), `值=${JSON.stringify(bad)}`).toThrow(/--max-turns/)
    }
  })
  it('缺少取值时报错', () => {
    expect(() => parseMaxTurns(['-p', '任务', '--max-turns'])).toThrow(/--max-turns/)
  })
  it('取值是另一个 flag 时报错，不吞掉它', () => {
    expect(() => parseMaxTurns(['--max-turns', '--yolo'])).toThrow(/--max-turns/)
  })
})
