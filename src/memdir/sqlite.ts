let suppressed = false
/** 只静默「node:sqlite 实验特性」这一条 ExperimentalWarning，其余警告照常。幂等。 */
function suppressSqliteWarning(): void {
  if (suppressed) return
  suppressed = true
  const original = process.emit
  ;(process as any).emit = function (name: string, data: any, ...rest: any[]) {
    if (name === 'warning' && data && data.name === 'ExperimentalWarning' && /SQLite/i.test(String(data.message))) {
      return false
    }
    return (original as any).apply(process, [name, data, ...rest])
  }
}

/** 内存 FTS5 库句柄。调用方负责建表/装载/close。 */
export async function createFtsDb(): Promise<import('node:sqlite').DatabaseSync> {
  suppressSqliteWarning()
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(':memory:')
}
