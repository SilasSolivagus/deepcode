import { defineConfig } from 'vitepress'

const zhSidebar = [
  { text: '开始', collapsed: false, items: [
    { text: '概览', link: '/guide/overview' },
    { text: '快速上手', link: '/guide/quickstart' },
    { text: 'deepcode 如何工作', link: '/guide/how-it-works' },
  ]},
  { text: '配置', collapsed: true, items: [
    { text: '安装与更新', link: '/config/install' },
    { text: '多 provider', link: '/config/providers' },
    { text: 'settings 与环境变量', link: '/config/settings' },
  ]},
  { text: '使用', collapsed: true, items: [
    { text: '交互 TUI', link: '/usage/tui' },
    { text: 'headless', link: '/usage/headless' },
    { text: '命令与快捷键', link: '/usage/commands' },
    { text: '权限模式', link: '/usage/permissions' },
    { text: '转向 / rewind / compact', link: '/usage/steering' },
  ]},
  { text: '工具与能力', collapsed: true, items: [
    { text: '工具总览', link: '/tools/overview' },
    { text: '记忆系统', link: '/tools/memory' },
    { text: '子代理 & worktree', link: '/tools/subagents' },
    { text: '工作流 loop', link: '/tools/workflows' },
    { text: 'MCP', link: '/tools/mcp' },
    { text: 'Skills', link: '/tools/skills' },
    { text: 'Hooks', link: '/tools/hooks' },
  ]},
  { text: '多模态', collapsed: true, items: [
    { text: '图片视觉', link: '/multimodal/vision' },
    { text: 'PDF/文档输入', link: '/multimodal/documents' },
  ]},
  { text: '评测', collapsed: true, items: [
    { text: '复现成本-可靠性 Pareto', link: '/eval/benchmark' },
  ]},
  { text: '参考 & 排错', collapsed: true, items: [
    { text: 'CLI 参考', link: '/reference/cli' },
    { text: '命令参考', link: '/reference/commands' },
    { text: '工具参考', link: '/reference/tools' },
    { text: 'settings 参考', link: '/reference/settings' },
    { text: '术语表', link: '/reference/glossary' },
    { text: '排错', link: '/reference/troubleshooting' },
  ]},
]

// 英文侧边栏：同结构，text 译英，link 加 /en 前缀
const enSidebar = zhSidebar.map(g => ({
  ...g,
  items: g.items.map(it => ({ ...it, link: '/en' + it.link })),
  text: ({ '开始':'Getting Started','配置':'Configuration','使用':'Using deepcode',
    '工具与能力':'Tools & Capabilities','多模态':'Multimodal','评测':'Benchmarks',
    '参考 & 排错':'Reference & Troubleshooting' } as Record<string,string>)[g.text] || g.text,
}))
// 注：英文 items 的 text 由 Task 2/3-5 各页 frontmatter/内容体现；侧边栏 text 用英文，逐条在下方覆盖。
enSidebar.forEach(g => g.items.forEach((it: any) => {
  const map: Record<string,string> = {
    '/en/guide/overview':'Overview','/en/guide/quickstart':'Quickstart','/en/guide/how-it-works':'How it works',
    '/en/config/install':'Install & update','/en/config/providers':'Providers','/en/config/settings':'Settings & env',
    '/en/usage/tui':'Interactive TUI','/en/usage/headless':'Headless','/en/usage/commands':'Commands & keys',
    '/en/usage/permissions':'Permission modes','/en/usage/steering':'Steering / rewind / compact',
    '/en/tools/overview':'Tools overview','/en/tools/memory':'Memory','/en/tools/subagents':'Subagents & worktree',
    '/en/tools/workflows':'Workflows (loop)','/en/tools/mcp':'MCP','/en/tools/skills':'Skills','/en/tools/hooks':'Hooks',
    '/en/multimodal/vision':'Image vision','/en/multimodal/documents':'PDF / documents','/en/eval/benchmark':'Reproduce the benchmark',
    '/en/reference/cli':'CLI reference','/en/reference/commands':'Commands reference','/en/reference/tools':'Tools reference',
    '/en/reference/settings':'Settings reference','/en/reference/glossary':'Glossary','/en/reference/troubleshooting':'Troubleshooting',
  }
  it.text = map[it.link] || it.text
}))

const nav = (en: boolean) => ([
  { text: en ? 'Guide' : '指南', link: en ? '/en/guide/overview' : '/guide/overview' },
  { text: en ? 'Website' : '官网', link: 'https://deepcode.dirctable.com' },
  { text: 'npm', link: 'https://www.npmjs.com/package/@silassolivagus/deepcode' },
])

export default defineConfig({
  base: '/docs/',
  cleanUrls: true,
  lang: 'zh-CN',
  title: 'deepcode 深度编程',
  description: '直连 DeepSeek / GLM / Kimi 的终端编码 agent 的官方文档',
  themeConfig: {
    logo: undefined,
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/SilasSolivagus/deepcode' }],
  },
  locales: {
    root: {
      label: '中文', lang: 'zh-CN',
      themeConfig: { nav: nav(false), sidebar: zhSidebar,
        outlineTitle: '本页目录', docFooter: { prev: '上一页', next: '下一页' } },
    },
    en: {
      label: 'English', lang: 'en', link: '/en/',
      themeConfig: { nav: nav(true), sidebar: enSidebar },
    },
  },
})
