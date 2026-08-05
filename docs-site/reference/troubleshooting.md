---
title: 排错
---
# 排错

按你**实际看到的那句话**查。所有条目都对应源码里真实存在的消息，不是设想出来的场景。

::: info 这页还不完整
现在是「错误消息对照表」——照着源码里的消息逐条写的。**还缺「用户最常卡在哪」那一半**，
那要真实使用反馈才写得准，硬排序就是编。遇到这里没有的问题，
[提个 issue](https://github.com/SilasSolivagus/deepcode/issues/new/choose) 一起补上。
:::

## 启动与配置

**`缺少 <provider> API key。设置环境变量 …=…，或在 ~/.deepcode/settings.json 的 providers.<x>.apiKey 配置`**
没配当前 provider 的 key。两条路任选：设环境变量（优先级更高），或写进 settings。
交互式下直接跑 `deepcode` 会进首跑向导；已经在用了可以 `/setup` 重配。

**`stdin 为空。交互模式请直接运行 deepcode，或用 -p "<任务>"`**
你在非终端环境（管道、CI）里启动了它，但没给任务。要么用 `-p "<任务>"`，要么真的从 stdin 喂
内容进去。

## 命令行参数

这些都是**当场报错、不静默回落**——参数写错了却按默认值跑完，事后无从分辨。

| 看到的消息 | 怎么办 |
|---|---|
| `--max-turns 需要一个正整数取值` / `只接受正整数，收到：X` | 给个正整数，`0` 和负数都不行 |
| `--model 需要一个模型名取值` | `--model` 后面漏了值，或值以 `-` 开头被当成了下一个参数 |
| `--permission-mode 需要一个取值` | 同上 |
| `--permission-mode 只支持 default\|acceptEdits\|yolo\|plan\|auto\|dontAsk` | 拼错了。**这层校验很重要**：拼错一个字母会让权限判定所有分支都不命中、静默退化成 `default` |
| `--output-format 只支持 text\|json\|stream-json，收到：X` | 三选一 |
| `--trace 需要一个目录路径` | `--trace` 后面漏了路径 |
| `--yolo 与 --permission-mode X 冲突` | 两个都给了且不一致。`--yolo` 等价于 `--permission-mode yolo`，只给一个 |

## 上下文超长

| 看到的消息 | 含义 |
|---|---|
| `⚠ 上下文超长，已甩掉 ~N tok 旧工具输出后重试` | **正常自愈**，不用管 |
| `⚠ 上下文超长且无可回收的旧工具输出，已停止。` | 没有可回收的余量了。分块读大文件，或缩小任务范围 |
| `⚠ 压缩后仍超长，已停止。请分块读取大文件或缩小任务范围。` | 同上，压缩也救不回来 |

根子上通常是**一次读了太大的文件**。用 `Read` 的 `offset`/`limit` 分段，或者让它先 `Grep`
定位再读那一段。`DEEPCODE_MAX_CONTEXT_TOKENS` 可以覆盖窗口推断，但那治标不治本。

## 步数上限

**`⚠ 已达步数上限，进入收尾轮：停止探索，落地当前最好的修改`**
撞到 headless 的步数预算了。用 `--max-turns <n>` 调高，或者把任务拆小。

::: tip 撞上限不等于活没干完
实测里撞上限的跑照样能拿到不错的结果——它只是被截断在「还想再检查一遍」的时候。
先看产出，别直接重跑。
:::

## worktree

| 看到的消息 | 怎么办 |
|---|---|
| `当前目录不是 git 仓库，无法创建 worktree。` | worktree 隔离要求在 git 仓库里 |
| `isolation:"worktree" 需要 git 仓库（或配置 WorktreeCreate hook）` | 同上，或配一个 `WorktreeCreate` hook 自己接管 |
| `已在 worktree 会话中（先 ExitWorktree 退出）。` | 不能套娃，先 `ExitWorktree` |
| `创建 worktree 失败：<git 报错>` | 后面那段是 git 的原始输出，按它查 |
| `sparse-checkout 失败：<git 报错>` | settings 里 `worktree.sparsePaths` 配的路径有问题 |

## 子代理

**`子代理嵌套已达上限 N 层，不能再派子代理。请在当前层完成剩余工作。`**
子代理不能无限往下派。这是防失控的硬上限——**在当前层把活干完**，不要试图再拆。

**返回内容开头有「⚠️ 子代理未跑完就撞上了轮次预算上限」**
它被截断了，**下面那段是中间状态不是结论**。不要据此认为任务完成或验证通过。要么缩小范围
重派一个，要么让它把独立检查并成一轮批量执行——实测反复撞上限多半是「一轮一条」把预算烧在
了往返上，不是预算真的不够。

## 文档解析

| 看到的消息 | 含义 |
|---|---|
| `文档解析超时` | 超过 180 秒。文档太大或网络慢 |
| `文档解析失败：HTTP <码>` | 服务端返回非 2xx，按状态码查 |
| `文档解析失败：响应无 md_results` | 响应结构不对，通常是端点配置有问题 |

文档解析走 GLM-OCR，需要 GLM 的 key——**但不要求把 active provider 切到 GLM**。

## MCP

**`Server "X" not found. Available servers: …`**
server 名写错了，或者那个 server 没连上。`/mcp` 看当前已连接的。

## 轨迹与开关

| 看到的消息 | 含义 |
|---|---|
| `⚠ --trace/DEEPCODE_TRACE_DIR 在交互式 TUI 下不生效` | 请求侧轨迹只支持 `-p` 与管道两条 headless 入口。**它不静默吞掉，会明确告诉你** |
| `⚠ 轨迹目录权限过宽（NNN），已收紧为 0700` | 安全兜底，已自动处理。轨迹含完整上下文（可能有密钥），不该给别人读 |
| `⚠ DEEPCODE_FLAGS 解析失败，已整体忽略（全部 flag 走默认值）` | JSON 写错了。**整体忽略而不是部分生效**——半开半关的实验组比全关更难查 |

## 自查

`/doctor` 会检查安装、配置与连通性。`/config` 看合并后的配置与每一项来自哪一层——
**配置没生效时先看这个**，多半是被层级覆盖了，或者是项目层的[危险字段被剥离](/reference/settings#分层与-危险字段剥离)了。

---

相关：[CLI 参考](/reference/cli) · [settings 参考](/reference/settings) · [命令参考](/reference/commands)
