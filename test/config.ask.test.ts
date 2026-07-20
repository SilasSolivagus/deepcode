// test/config.ask.test.ts
import { describe, it, expect } from 'vitest'
import { parsePermissions } from '../src/config.js'

describe('parsePermissions ask + dontAsk', () => {
  it('解析并清洗 ask 列表', () => {
    const r = parsePermissions({ permissions: { ask: ['Bash(rm:*)', ' **/.env ', '', 42] } })
    expect(r.ask).toEqual(['Bash(rm:*)', '**/.env'])
  })
  it('接受 defaultMode: dontAsk', () => {
    const r = parsePermissions({ permissions: { defaultMode: 'dontAsk' } })
    expect(r.defaultMode).toBe('dontAsk')
  })
  it('无 ask 时不设字段', () => {
    expect(parsePermissions({ permissions: {} }).ask).toBeUndefined()
  })
})
