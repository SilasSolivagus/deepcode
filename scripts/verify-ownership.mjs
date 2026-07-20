// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Silas <dirctable@gmail.com>
// deepcode — https://github.com/SilasSolivagus/deepcode
//
// 署名回归守卫（非防篡改）：只捕捉本仓库/贡献者的误删，让 CI 变红提醒维护者。
// 真正的防抄袭靠版权法 + GitHub 公开时间戳历史 + LICENSE。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'Silas <dirctable@gmail.com>'
const COPYRIGHT = `Copyright (c) 2026 ${OWNER}`
const SPDX = `SPDX-FileCopyrightText: 2026 ${OWNER}`

const SPDX_ANCHORS = ['src/index.ts', 'src/loop.ts', 'src/api.ts', 'src/tui/index.tsx']
const failures = []

function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf8') }
  catch { failures.push(`${rel}: 文件缺失`); return '' }
}

if (!read('LICENSE').includes(COPYRIGHT)) failures.push(`LICENSE: 缺版权行 "${COPYRIGHT}"`)

try {
  const pkg = JSON.parse(read('package.json'))
  if (!pkg.author || !pkg.author.includes('Silas')) failures.push('package.json: author 缺失或不含 Silas')
} catch { failures.push('package.json: 无法解析') }

for (const f of SPDX_ANCHORS) {
  const src = read(f)
  if (src && !src.includes(SPDX)) failures.push(`${f}: 缺 SPDX 版权头`)
}

if (!read('src/tui/components/Banner.tsx').includes('© Silas'))
  failures.push('Banner.tsx: 缺运行时署名 © Silas')

if (failures.length) {
  console.error('✗ 署名校验失败：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ 署名校验通过：LICENSE + package.json + ${SPDX_ANCHORS.length} 个 SPDX 锚点 + Banner 署名。`)
