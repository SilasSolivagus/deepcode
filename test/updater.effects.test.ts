import { describe, it, expect, vi } from 'vitest'
import { resolveRegistry, fetchLatest, runUpgrade, PKG, CHECK_TIMEOUT_MS } from '../src/updater.js'

describe('resolveRegistry', () => {
  it('用 npm config 的 registry', () => {
    expect(resolveRegistry(() => 'https://registry.npmmirror.com/')).toBe('https://registry.npmmirror.com')
  })
  it('取不到时回落官方源', () => {
    expect(resolveRegistry(() => null)).toBe('https://registry.npmjs.org')
  })
  it('非 http/https 一律回落官方源', () => {
    expect(resolveRegistry(() => 'file:///etc/passwd')).toBe('https://registry.npmjs.org')
    expect(resolveRegistry(() => '不是URL')).toBe('https://registry.npmjs.org')
  })
})

describe('fetchLatest', () => {
  it('返回 registry 的 version 字段', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ version: '0.9.3' }) })
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBe('0.9.3')
    expect(doFetch).toHaveBeenCalledWith(
      `https://r.example/${PKG}/latest`,
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it('恶意 registry 可重定向到内网地址 → redirect:error 拒绝跟随', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ version: '0.9.3' }) })
    await fetchLatest('https://r.example', 3000, doFetch as any)
    expect(doFetch).toHaveBeenCalledWith(
      `https://r.example/${PKG}/latest`,
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('响应体超过 64KB → null（防恶意 registry 打爆内存/解析）', async () => {
    const huge = JSON.stringify({ version: '0.9.3', pad: 'x'.repeat(70 * 1024) })
    const doFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => huge })
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBeNull()
  })

  it('非 200 → null', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: false, text: async () => '' })
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBeNull()
  })

  it('网络异常 → null 而不抛', async () => {
    const doFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBeNull()
  })

  it('JSON 无 version 字段 → null', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ name: 'x' }) })
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBeNull()
  })

  it('损坏的 JSON → null 而不抛', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '{ 坏掉的' })
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBeNull()
  })

  it('version 含 ESC 控制序列（终端注入）→ null', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ version: '0.9.3\x1b[2J' }) })
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBeNull()
  })

  it('version 超长数字串（非常规格式）→ null', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ version: '9'.repeat(50) + '.0.0' }) })
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBeNull()
  })

  it('version 是正常 semver（含预发布后缀）→ 正常返回', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ version: '1.2.3-beta.1' }) })
    await expect(fetchLatest('https://r.example', 3000, doFetch as any)).resolves.toBe('1.2.3-beta.1')
  })

  it('真正超时 → abort 触发, 返回 null', async () => {
    vi.useFakeTimers()
    try {
      let capturedSignal: AbortSignal | undefined
      const doFetch = vi.fn((_url: string, opts: { signal: AbortSignal }) => {
        capturedSignal = opts.signal
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('AbortError')))
        })
      })
      const promise = fetchLatest('https://r.example', 3000, doFetch as any)
      await vi.advanceTimersByTimeAsync(3000)
      await expect(promise).resolves.toBeNull()
      expect(capturedSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // 真机冒烟实测：国内网络冷进程连 registry.npmjs.org 要 1.8~8.2 秒，
  // 旧的 3 秒默认超时几乎必然 abort → 页脚永远不提示、/update 恒报「检查失败」。
  it('默认超时是 CHECK_TIMEOUT_MS，3 秒时仍未放弃', async () => {
    vi.useFakeTimers()
    try {
      const doFetch = vi.fn((_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('AbortError')))
        }))
      const promise = fetchLatest('https://r.example', undefined, doFetch as any)
      let settled = false
      void promise.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(3000)
      expect(settled).toBe(false) // 3 秒还在等，不像旧默认那样已放弃
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 3000)
      await expect(promise).resolves.toBeNull()
      expect(CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runUpgrade', () => {
  it('用固定 argv 数组调 npm，退出码 0 → true', async () => {
    const spawnFn = vi.fn((_c: string, _a: string[], _o: any) => ({
      on(ev: string, cb: (arg: any) => void) { if (ev === 'close') setTimeout(() => cb(0), 0) },
      kill() {},
    }))
    await expect(runUpgrade(spawnFn as any)).resolves.toBe(true)
    expect(spawnFn).toHaveBeenCalledWith('npm', ['i', '-g', `${PKG}@latest`], { stdio: 'ignore' })
  })

  it('非 0 退出码 → false', async () => {
    const spawnFn = vi.fn(() => ({
      on(ev: string, cb: (arg: any) => void) { if (ev === 'close') setTimeout(() => cb(1), 0) },
      kill() {},
    }))
    await expect(runUpgrade(spawnFn as any)).resolves.toBe(false)
  })

  it('spawn error → false 而不抛', async () => {
    const spawnFn = vi.fn(() => ({
      on(ev: string, cb: (arg: any) => void) { if (ev === 'error') setTimeout(() => cb(new Error('ENOENT')), 0) },
      kill() {},
    }))
    await expect(runUpgrade(spawnFn as any)).resolves.toBe(false)
  })

  it('超时 → kill 子进程并 false', async () => {
    const kill = vi.fn()
    const spawnFn = vi.fn(() => ({ on() {}, kill }))
    await expect(runUpgrade(spawnFn as any, 10)).resolves.toBe(false)
    expect(kill).toHaveBeenCalled()
  })

  it('spawnFn 同步抛出（EAGAIN/EMFILE 等资源耗尽）→ false 而不是 rejected promise', async () => {
    const spawnFn = vi.fn(() => { throw new Error('EAGAIN') })
    await expect(runUpgrade(spawnFn as any)).resolves.toBe(false)
  })
})
