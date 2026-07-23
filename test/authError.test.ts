// test/authError.test.ts
// isAuthError 纯逻辑：401/403/invalid_api_key/Unauthorized → true；429/5xx/网络超时/普通错误 → false（保守，不误判限流为失效）。
import { describe, it, expect } from 'vitest'
import { isAuthError } from '../src/api.js'

describe('isAuthError', () => {
  it('HTTP 401 → true', () => {
    expect(isAuthError({ status: 401 })).toBe(true)
  })

  it('HTTP 403 → true', () => {
    expect(isAuthError({ status: 403 })).toBe(true)
  })

  it('body message 含 invalid_api_key → true', () => {
    expect(isAuthError({ message: 'invalid_api_key' })).toBe(true)
  })

  it('message 含 Unauthorized → true', () => {
    expect(isAuthError({ message: 'Error: Unauthorized access to this resource' })).toBe(true)
  })

  it('HTTP 500 → false（不误判服务端错误为鉴权失效）', () => {
    expect(isAuthError({ status: 500 })).toBe(false)
  })

  it('HTTP 429 限流 → false（关键：绝不能把限流误判为 key 失效，否则会反复弹重录）', () => {
    expect(isAuthError({ status: 429, message: 'Rate limit reached' })).toBe(false)
  })

  it('网络超时 → false', () => {
    expect(isAuthError({ code: 'ETIMEDOUT', message: 'Connection timed out' })).toBe(false)
    expect(isAuthError(new Error('Request timed out.'))).toBe(false)
  })

  it('普通错误 → false', () => {
    expect(isAuthError({ message: 'rate limit' })).toBe(false)
    expect(isAuthError(new Error('something went wrong'))).toBe(false)
  })

  it('非对象 / null / undefined → false', () => {
    expect(isAuthError(null)).toBe(false)
    expect(isAuthError(undefined)).toBe(false)
    expect(isAuthError('plain string error')).toBe(false)
  })
})
