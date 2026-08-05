---
title: 术语表
---
# 术语表

按拼音排序。每条给一句话定义 + 指向详细页。

## A–H

**auto 模式** —— 一种权限模式：规则没命中时，交给一个分类器判 run / ask / block。**每次工具
调用会多一次模型调用**（约 3 秒 + 少量费用）。没有 `/auto` 命令，只能 `Shift+Tab` 或
`/cycle-mode` 进。→ [权限模式](/usage/permissions)

**dream** —— 记忆的后台归纳：把零散记忆整理成更概括的条目。门槛刻意高（距上次 ≥24 小时
**且** 新增 ≥5 个会话），因为它要调模型、跑太勤会把还没稳定的观察固化成「结论」。
→ [记忆系统](/tools/memory)

**flag（实验开关）** —— 由 `DEEPCODE_FLAGS` 环境变量控制的实验性机制，**默认全关**。存在的
意义是做 A/B 时两臂跑同一份代码、唯一差异是这个变量。→ [CLI 参考](/reference/cli)

**headless** —— 非交互模式：`deepcode -p "<任务>"` 或管道喂入，跑完即退。给脚本和 CI 用。
→ [headless / CI](/usage/headless)

**hook** —— 生命周期钩子，在特定事件（会话开始、提交前、子代理结束等）跑你指定的命令或
HTTP 请求。→ [Hooks](/tools/hooks)

## J–P

**记忆 vs 指令文件** —— `DEEPCODE.md` 是**你写的规矩**，每次完整注入、优先级高；记忆是**它
自己攒的观察**，可能过时可能记错。发现记忆有错直接改那个 `.md`。→ [记忆系统](/tools/memory)

**MCP** —— Model Context Protocol，通过 stdio 接入外部工具 server。`/mcp` 看已连接的。
→ [MCP](/tools/mcp)

**pass^N** —— 同一题跑 N 个 seed **全中**才算过。用来量可靠性——单跑一次全过、跑三次只过
一次的模型，pass@1 看不出来。→ [跑分](/eval/benchmark)

**pipeline / parallel** —— 工作流里的两种编排：`pipeline` 每个条目独立走完全部阶段、阶段间
无屏障；`parallel` 是屏障，最慢的不跑完后面一个都别想动。**默认该用 pipeline**。
→ [工作流](/tools/workflows)

**plan 模式** —— 只读权限模式，任何非只读工具一律拒绝。退出时**恢复进入前那个模式**，不是
一律回 default。→ [权限模式](/usage/permissions)

## Q–Z

**请求侧轨迹** —— `--trace <dir>` 把发给模型的每个请求原样落盘。stream-json 给的是**模型说
了什么**，请求轨迹给的是**我们说了什么**（系统提示、注入的提醒、压缩后的历史、hook 输出）。
⚠️ 含完整上下文、可能有密钥。→ [CLI 参考](/reference/cli#trace-请求侧轨迹)

**全局抽屉** —— 跨项目的记忆层（`~/.deepcode/memory/`）。`maxBytes` 是**注入预算不是存储
上限**——超了降级成索引清单。→ [记忆系统](/tools/memory)

**危险字段剥离** —— 项目层（仓库里的）配置会被剥掉约 20 个键，因为项目配置可能来自不受信任
的仓库。每一条都有具体攻击面，不是一刀切。→ [settings 参考](/reference/settings#分层与-危险字段剥离)

**验证子代理** —— 专职「试图弄坏这份实现」的子代理，**判定权归它独占**，主代理不能自评通过。
flag 门控、默认关。→ [子代理](/tools/subagents#验证子代理)

**压缩（compact）** —— 上下文接近窗口上限时把历史压成摘要。触发阈值可配，也可以 `/compact`
手动触发。→ [转向 / rewind / compact](/usage/steering)

**只读短路** —— 声明了 `isReadOnly` 的工具会被权限链短路放行，**但 deny 规则仍然优先**。
→ [权限模式](/usage/permissions)

**子代理** —— 一次性、上下文隔离的执行单元。**它看不到当前对话**，prompt 必须自包含。
→ [子代理](/tools/subagents)

**stream-json** —— 输出格式之一：逐事件一行 JSON 打到 stdout，工具参数与结果不截断，可直接
`jq` 消费。→ [headless / CI](/usage/headless)

**worktree 隔离** —— 给子代理开一个临时 git worktree（仓库的隔离副本）。适合多个子代理并行
改同一个仓库时；没改动会自动清理。→ [子代理](/tools/subagents#worktree-隔离)

**工作流** —— 用一段确定性 JavaScript 编排多个子代理。脚本里 `Date.now()`/`Math.random()`
被删掉了，因为断点续跑依赖「同脚本同参数 = 同调用序列」。→ [工作流](/tools/workflows)
