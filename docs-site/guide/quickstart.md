---
title: 快速上手
---

# 快速上手

## 安装

Node ≥ 22.5：

```bash
npm i -g @silassolivagus/deepcode
```

## 首跑

直接跑 `deepcode`，首次运行会弹出向导，粘贴 key 即可（写入 `~/.deepcode/settings.json`，权限 600）：

```bash
deepcode
```

已有 key 也可以跳过向导，直接用环境变量：

```bash
export DEEPSEEK_API_KEY=sk-...
deepcode
```

默认模型是 `deepseek-v4-pro`。想切 GLM / Kimi / 自建后端，见 [多 provider 配置](/config/providers)。

## 跑通第一个任务

进入交互式 TUI 后，直接把任务说清楚：

```
> 给 utils 补单测并跑通
```

deepcode 会自己规划、调工具、跑测试，典型的一轮大概长这样：

```
› 给 utils 补单测并跑通

  Grep  搜索 utils 相关文件
  Read  src/utils.ts
  Edit  src/utils.test.ts
  Bash  npm test

  utils.ts 里 4 个函数补了单测，npm test 跑通（12 passed）。

  ¥0.03 · 3 turns · 8.2k tokens
```

Grep → Read → Edit → 自测，跑完给一个成本行结算，全程可见、可打断。

如果只想要一次性结果、不进交互界面，用 headless 模式：

```bash
deepcode -p "给 utils 补单测并跑通"
```

需要结构化结果（脚本 / CI 里接入）时加 `--json`，输出包含 `text` / `status` / `turns` / `usage` / `costCNY`：

```bash
deepcode -p "给 utils 补单测并跑通" --json
```

## 下一步

- [多 provider 配置](/config/providers)：切 DeepSeek / GLM / Kimi / 自建后端。
- [命令](/usage/commands)：`/model`、`/think`、`/plan`、`/cost` 等常用命令一览。
- [如何工作](/guide/how-it-works)：主循环、工具、权限与记忆的整体架构。
