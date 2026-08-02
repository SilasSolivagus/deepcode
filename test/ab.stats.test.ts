import { describe, it, expect } from 'vitest'
import { fisherOneTailed } from '../bench/ab/stats.js'

describe('fisherOneTailed', () => {
  it('5/5 vs 0/5 → p≈0.004（够格说话）', () => {
    expect(fisherOneTailed(5, 0, 0, 5)).toBeCloseTo(0.003968, 5)
  })

  it('5/5 vs 3/5 → p≈0.22（效应弱，k=5 判不出来）', () => {
    expect(fisherOneTailed(5, 0, 3, 2)).toBeCloseTo(0.2222, 4)
  })

  it('两臂完全相同 → p 接近 1（无差异）', () => {
    expect(fisherOneTailed(3, 2, 3, 2)).toBeGreaterThan(0.5)
  })

  it('臂一反而更差 → p 接近 1（单尾只检验臂一更好）', () => {
    expect(fisherOneTailed(0, 5, 5, 0)).toBeCloseTo(1, 5)
  })

  it('#6 记忆里算过的那组：10/12 vs 6/12 单尾 p≈0.0965', () => {
    expect(fisherOneTailed(10, 2, 6, 6)).toBeCloseTo(0.0965, 3)
  })

  it('全零分母不炸（两臂都没有有效样本）', () => {
    expect(fisherOneTailed(0, 0, 0, 0)).toBe(1)
  })

  it('p 值恒在 [0,1] 内', () => {
    for (const [a, b, c, d] of [[1,4,4,1],[4,1,1,4],[2,3,2,3],[5,0,5,0]]) {
      const p = fisherOneTailed(a, b, c, d)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })

  it('负数入参应抛错', () => {
    expect(() => fisherOneTailed(-1, 2, 3, 4)).toThrow(/参数 a 必须是非负整数/)
    expect(() => fisherOneTailed(1, -1, 3, 4)).toThrow(/参数 b 必须是非负整数/)
    expect(() => fisherOneTailed(1, 2, -1, 4)).toThrow(/参数 c 必须是非负整数/)
    expect(() => fisherOneTailed(1, 2, 3, -1)).toThrow(/参数 d 必须是非负整数/)
  })

  it('小数入参应抛错', () => {
    expect(() => fisherOneTailed(2.5, 2, 3, 4)).toThrow(/参数 a 必须是非负整数/)
    expect(() => fisherOneTailed(2, 2.5, 3, 4)).toThrow(/参数 b 必须是非负整数/)
    expect(() => fisherOneTailed(2, 2, 3.5, 4)).toThrow(/参数 c 必须是非负整数/)
    expect(() => fisherOneTailed(2, 2, 3, 4.5)).toThrow(/参数 d 必须是非负整数/)
  })

  it('NaN 入参应抛错', () => {
    expect(() => fisherOneTailed(NaN, 2, 3, 4)).toThrow(/参数 a 必须是非负整数/)
    expect(() => fisherOneTailed(2, NaN, 3, 4)).toThrow(/参数 b 必须是非负整数/)
    expect(() => fisherOneTailed(2, 3, NaN, 4)).toThrow(/参数 c 必须是非负整数/)
    expect(() => fisherOneTailed(2, 3, 4, NaN)).toThrow(/参数 d 必须是非负整数/)
  })

  it('Infinity 入参应抛错', () => {
    expect(() => fisherOneTailed(Infinity, 2, 3, 4)).toThrow(/参数 a 必须是非负整数/)
    expect(() => fisherOneTailed(2, Infinity, 3, 4)).toThrow(/参数 b 必须是非负整数/)
    expect(() => fisherOneTailed(2, 3, Infinity, 4)).toThrow(/参数 c 必须是非负整数/)
    expect(() => fisherOneTailed(2, 3, 4, Infinity)).toThrow(/参数 d 必须是非负整数/)
  })
})
