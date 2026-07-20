// emacs kill ring（纯逻辑）。continuing=同一串连续删除并入顶条目；否则新起条目。yank 取顶、yankPop 轮换。
export interface KillRing { entries: string[]; yankIndex: number }

export function emptyKillRing(): KillRing { return { entries: [], yankIndex: 0 } }

export function kill(ring: KillRing, text: string, dir: 'append' | 'prepend', continuing: boolean): KillRing {
  if (!text) return ring
  if (!continuing || ring.entries.length === 0) {
    return { entries: [text, ...ring.entries].slice(0, 10), yankIndex: 0 } // 新起条目到顶
  }
  const top = ring.entries[0]
  const merged = dir === 'append' ? top + text : text + top
  return { entries: [merged, ...ring.entries.slice(1)].slice(0, 10), yankIndex: 0 }
}

export function yank(ring: KillRing): { ring: KillRing; text: string } {
  if (ring.entries.length === 0) return { ring, text: '' }
  return { ring: { ...ring, yankIndex: 0 }, text: ring.entries[0] }
}

export function yankPop(ring: KillRing): { ring: KillRing; text: string } {
  if (ring.entries.length === 0) return { ring, text: '' }
  const next = (ring.yankIndex + 1) % ring.entries.length
  return { ring: { ...ring, yankIndex: next }, text: ring.entries[next] }
}
