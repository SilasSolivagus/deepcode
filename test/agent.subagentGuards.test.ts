import { describe, it, expect } from 'vitest'
import { MAX_SUBAGENT_DEPTH } from '../src/tools/agent.js'

describe('子代理嵌套守卫', () => {
  it('深度上限为 2（主→子→孙，孙再派即拒）', () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(2)
  })

  it('depth 判定：0/1 可派，2 及以上不可派', () => {
    const canSpawn = (d: number | undefined) => (d ?? 0) < MAX_SUBAGENT_DEPTH
    expect(canSpawn(undefined)).toBe(true)
    expect(canSpawn(0)).toBe(true)
    expect(canSpawn(1)).toBe(true)
    expect(canSpawn(2)).toBe(false)
    expect(canSpawn(3)).toBe(false)
  })
})
