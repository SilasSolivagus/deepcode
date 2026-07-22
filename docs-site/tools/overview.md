---
title: 工具总览
---

# 工具总览

## 工具是什么

deepcode 的主循环靠一组内置工具干活：读写文件、搜索代码、执行命令、派生子代理/技能、访问网络与长期记忆、管理后台任务与定时任务。每次工具调用都会在 TUI 里实时展示，并按当前[权限模式](/usage/permissions)决定要不要弹窗确认。

## 按类分组

下表按用途分组列出内置工具（工具名取自源码，与实际注册一致）；「只读」列对应工具的 `isReadOnly` 属性，决定它是否会被权限系统自动放行——具体判定规则见下一节。

### 文件与 notebook

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `Read` | 读取文件内容，带行号；编辑任何文件前必须先读 | ✓ |
| `Write` | 整文件写入（新建或覆盖），已存在文件覆盖前必须先 `Read` | |
| `Edit` | 对文件做精确字符串替换 | |
| `NotebookEdit` | 编辑 Jupyter notebook（.ipynb）的单个 cell：替换/插入/删除，不执行 cell | |

### 搜索

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `Glob` | 按 glob 模式查找文件路径（自动忽略 `node_modules`/`.git`） | ✓ |
| `Grep` | 按正则在文件内容中搜索，返回 文件:行号:行内容 | ✓ |

### 执行

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `Bash` | 在持久化工作目录中执行 shell 命令，可前台或转后台 | |

### agent 编排

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `Agent` | 派生一次性子代理完成子任务，子代理看不到当前对话上下文 | ✓ |
| `Workflow` | 用确定性 JavaScript 编排多个子代理（循环/条件/并发扇出） | ✓ |
| `Skill` | 调用一个技能，技能指令作为独立消息交付并执行 | ✓ |
| `TaskCreate` | 在任务清单中创建一个任务 | |
| `TaskGet` | 按 id 取一个任务的全部字段 | ✓ |
| `TaskUpdate` | 更新任务状态/字段（含依赖阻塞判定） | |
| `TaskList` | 列出当前任务清单 | ✓ |
| `BgTaskList` | 列出所有后台进程任务 | ✓ |
| `TaskOutput` | 读取后台任务输出（增量或从指定偏移） | ✓ |
| `TaskStop` | 按 id 停止一个运行中的后台任务 | ✓ |

### 记忆

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `SearchMemory` | 在长期记忆（项目内 + 跨项目全局抽屉）里全文检索相关片段 | ✓ |

### 网络

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `WebFetch` | 抓取一个 http(s) URL，按 prompt 提取或总结内容 | |
| `WebSearch` | 搜索网络获取最新信息，返回标题/链接/摘要 | |

### 定时与通知

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `Sleep` | 等待指定秒数，用户可随时中断 | ✓ |
| `ScheduleWakeup` | 安排 `/loop` 动态模式下一次续跑 | ✓ |
| `CronCreate` | 按 cron 周期或一次性安排未来的任务 | ✓ |
| `CronList` | 列出本会话已安排的 cron 任务 | ✓ |
| `CronDelete` | 取消一个已安排的 cron 任务 | ✓ |
| `Monitor` | 启动后台监控，从长跑脚本流式取事件 | ✓ |
| `PushNotification` | 在用户终端发桌面通知 | ✓ |

### 交互与流程控制

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `AskUserQuestion` | 弹结构化多选题问用户（仅交互式可用） | ✓ |
| `ExitPlanMode` | plan 模式下请用户审批计划，通过后退出只读限制 | ✓ |

### worktree 隔离

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `EnterWorktree` | 创建隔离的 git worktree 并把当前会话切进去 | |
| `ExitWorktree` | 退出当前 worktree 会话，恢复到原工作目录 | |

### 配置

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `Config` | 读写用户级配置（敏感字段如 apiKey/hooks/mcpServers 不可经此工具改） | |

### 外部工具（MCP）

连接的 MCP server 会把各自的工具动态热插进这份工具表，不在上面固定清单里、名字由 server 自己定义。见 [MCP](/tools/mcp)。

### 工具在 TUI 里怎么显示

调用序列会实时列出「工具名 + 一句摘要」，跑完给一行成本结算：

```
› 给 utils 补单测并跑通

  Grep  搜索 utils 相关文件
  Read  src/utils.ts
  Edit  src/utils.test.ts
  Bash  npm test

  utils.ts 里 4 个函数补了单测，npm test 跑通（12 passed）。

  ¥0.03 · 3 turns · 8.2k tokens
```

## 权限类别

`isReadOnly` 为真的工具默认自动放行，不弹确认框；写文件/执行命令类工具默认需要你确认（除非权限模式或规则另有规定）。完整的判定优先级——deny 规则 > plan 模式只读 > 系统级安全兜底 > 只读短路 > allow/ask 规则——见 [权限模式](/usage/permissions)，这里不重复展开。

## 完整参数参考

每个工具的逐个参数、输入 schema 见 [工具参考](/reference/tools)。

---

下一步：[MCP](/tools/mcp)（连接外部工具）、[权限模式](/usage/permissions)。
