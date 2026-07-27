import { defineConfig } from 'vitest/config'

// 只跑 test/ 下的单测。bench/fixtures/*.test.mjs 是给 agent 修的「故意写错」基准夹具
// （node:test 写的），无配置时 vitest 默认 glob 会把它们扫进来导致间歇性误报——这里显式排除。
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // 兜底：测试环境默认彻底关闭升级子系统（详见 src/updater.ts createUpdaterDeps 的
    // dev 短路——但 vitest worker 自身路径未必落在其 5 层向上查找范围内，不能单靠那层兜底）。
    env: { DEEPCODE_DISABLE_UPDATES: '1' },
  },
})
