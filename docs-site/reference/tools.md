---
title: 工具参考
---
# 工具参考

模型能调用的全部内置工具。**31 个**——20 个静态注册，11 个按会话构造（需要注入 client、
模型档、子代理清单等）。MCP server 的工具在此之外动态注入。

「需权限」一列的三种取值：

- **否**——永不询问
- **按输入判**——取决于具体参数（路径是否在工作目录内、命令是否命中规则等），走完整的
  [权限判定链](/usage/permissions)
- 声明了 `isReadOnly` 的工具会被权限链短路放行，**但 deny 规则仍然优先**

## 文件

| 工具 | 只读 | 需权限 | 作用 |
|---|---|---|---|
| `Read` | ✓ | 否 | 读文件，输出带行号。大文件用 `offset`/`limit` 分段。**编辑任何文件前必须先 Read** |
| `Glob` | ✓ | 否 | 按 glob 找文件，最多 100 条，自动忽略 `node_modules`/`.git` |
| `Grep` | ✓ | 否 | 按正则搜内容，返回「文件:行号:行内容」，最多 100 条。默认 ripgrep 语法 |
| `Edit` | | 按输入判 | 精确字符串替换。`old_string` 必须**逐字符一致**（含缩进换行）且默认要求唯一 |
| `Write` | | 按输入判 | 整文件写入，自动建父目录。**覆盖已有文件前必须先 Read 过它**；新建无此要求 |
| `NotebookEdit` | | 按输入判 | 编辑 `.ipynb` 的单个 cell：replace / insert / delete |

::: tip 找文件用 Glob，找内容用 Grep
不要用 `Bash` 跑 `find` / `grep`——专用工具有结果上限与忽略规则，输出更省上下文。
:::

## 执行

| 工具 | 只读 | 需权限 | 作用 |
|---|---|---|---|
| `Bash` | | 按输入判 | 在**持久化**工作目录里执行命令（`cd` 会影响后续所有命令）。默认 120 秒超时，输出超 30000 字符截断中间部分 |

## 网络

| 工具 | 只读 | 需权限 | 作用 |
|---|---|---|---|
| `WebFetch` | | 按输入判 | 抓一个 http(s) URL，按 prompt 从中提取或总结 |
| `WebSearch` | | 按输入判 | 搜网络获取最新信息，返回标题 / 链接 / 摘要 |

## 任务清单

| 工具 | 只读 | 需权限 | 作用 |
|---|---|---|---|
| `TaskCreate` | | 否 | 建一个任务。**3 步以上的活开始时先建清单** |
| `TaskUpdate` | | 否 | 更新任务。完成一项就标 completed 并把下一项标 in_progress——**同一时刻至多一项 in_progress** |
| `TaskGet` | ✓ | 否 | 按 id 取任务全部字段 |
| `TaskList` | ✓ | 否 | 列出当前清单 |

## 子代理与编排

| 工具 | 只读 | 需权限 | 作用 |
|---|---|---|---|
| `Agent` | ✓ | 否 | 派一个子代理。详见[子代理](/tools/subagents) |
| `Workflow` | ✓ | 按输入判 | 用确定性 JavaScript 脚本编排多个子代理。详见[工作流](/tools/workflows) |
| `Skill` | ✓ | 否 | 调用一个技能。详见 [Skills](/tools/skills) |

## 后台任务与调度

| 工具 | 只读 | 需权限 | 作用 |
|---|---|---|---|
| `Monitor` | ✓ | 否 | 启动后台监控，从长跑脚本流式取事件。**每行 stdout 是一个事件** |
| `BgTaskList` | ✓ | 否 | 列出所有后台任务（id / 状态 / 描述） |
| `TaskOutput` | ✓ | 否 | 取后台任务的输出 |
| `TaskStop` | ✓ | 否 | 按 id 停止运行中的后台任务（Monitor、后台 Bash、cron） |
| `Sleep` | ✓ | 否 | 等待指定秒数，用户随时可中断 |
| `CronCreate` | ✓ | 否 | 安排一个 prompt 在未来入队——cron 周期重复或一次性 |
| `CronList` | ✓ | 否 | 列出本会话安排的 cron 任务 |
| `CronDelete` | ✓ | 否 | 取消一个 cron 任务 |
| `ScheduleWakeup` | ✓ | 否 | `/loop` 动态模式下安排何时续跑 |

## 记忆

| 工具 | 只读 | 需权限 | 作用 |
|---|---|---|---|
| `SearchMemory` | ✓ | 否 | 在项目记忆 + 全局抽屉里全文检索。详见[记忆系统](/tools/memory) |

## 会话与环境

| 工具 | 只读 | 需权限 | 作用 |
|---|---|---|---|
| `Config` | | 按输入判 | 读写用户级配置。省略 `value` = 读合并值；给了 = 写入 user 层 |
| `ExitPlanMode` | ✓ | 否 | plan 模式下提交计划请用户批准。**只在 plan 模式可用** |
| `EnterWorktree` | | 否 | 建一个隔离 git worktree 并把会话切进去 |
| `ExitWorktree` | | 否 | 退出 worktree，`action=keep` 保留 / `remove` 删除 |
| `PushNotification` | ✓ | 否 | 发桌面通知把用户注意力拉回来。**这是成本，宁可不发** |
| `AskUserQuestion` | ✓ | 否 | 需要用户拍板时弹结构化选择题，而不是自作主张。1–4 题，每题 2–4 选项 |

## 子代理拿不到的工具

无论哪种类型，子代理一律禁用这 11 个：

```
ExitPlanMode  EnterWorktree  ExitWorktree  Workflow
ScheduleWakeup  CronCreate  CronList  CronDelete
Monitor  TaskStop  PushNotification
```

它们要么改变会话级状态、要么派生更多任务——**子代理不能自己再开分支**。各类型自身还有额外
限制（比如 `Explore` / `Plan` / `verification` 都禁 `Edit`/`Write`），见[子代理](/tools/subagents)。

## MCP 工具

MCP server 提供的工具在运行时注入，名字带 server 前缀。`/mcp` 可以查看已连接的 server 与它们
提供的工具。详见 [MCP](/tools/mcp)。

---

相关：[工具总览](/tools/overview) · [权限模式](/usage/permissions) · [子代理](/tools/subagents)
