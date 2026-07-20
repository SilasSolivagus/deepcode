import { describe, it, expect } from 'vitest'
import { createFtsDb } from '../src/memdir/sqlite.js'

describe('createFtsDb', () => {
  it('返回可用的内存 FTS5 库，MATCH + bm25 排序生效', async () => {
    const db = await createFtsDb()
    db.exec('CREATE VIRTUAL TABLE t USING fts5(body)')
    db.exec("INSERT INTO t(body) VALUES('tailwind css nice'),('native css only')")
    const rows = db.prepare("SELECT body, rank FROM t WHERE t MATCH 'css' ORDER BY rank").all()
    expect(rows.length).toBe(2)
    expect(typeof (rows[0] as any).rank).toBe('number')
    db.close()
  })
})
