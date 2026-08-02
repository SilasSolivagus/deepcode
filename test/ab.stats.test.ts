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
    expect(() => fisherOneTailed(0, 0, 0, 0)).not.toThrow()
  })

  it('p 值恒在 [0,1] 内', () => {
    for (const [a, b, c, d] of [[1,4,4,1],[4,1,1,4],[2,3,2,3],[5,0,5,0]]) {
      const p = fisherOneTailed(a, b, c, d)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })
})
