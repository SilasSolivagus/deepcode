---
title: CLI 参考
---
# CLI 参考

`deepcode` 的全部命令行参数与环境变量。跑 `deepcode --help` 可以随时看到当前版本的简版。

## 三种启动形态

```bash
deepcode                        # 交互式 TUI（首次运行会引导配置 API key）
deepcode -p "<任务>"             # 一次性 headless 输出
echo "<任务>" | deepcode         # 管道喂入，同样走 headless
```

没有 `-p`、stdin 又不是终端时（比如在 CI 里），deepcode 会把 stdin 全文当作任务走 headless。

## headless 参数

只在 `-p` 与管道这两条路径上生效。

| 参数 | 说明 |
|---|---|
| `--output-format <fmt>` | `text`（默认）\| `json` \| `stream-json` |
| `--json` | 等价于 `--output-format json` |
| `--max-turns <n>` | 本次跑的最大轮次。正整数，覆盖 settings 里的 `headlessMaxTurns` |
| `--trace <dir>` | 把发给模型的每个请求原样落盘为 `<dir>/req-NNNNN.json` |
| `--yolo` | 跳过所有权限询问 |

### 三种输出格式

- **`text`**：只把最终回答打到 stdout；工具调用的过程打到 stderr。适合人看。
- **`json`**：最终结果一行 JSON——`text` / `status` / `turns` / `usage` / `costCNY`。
- **`stream-json`**：逐事件一行 JSON 打到 stdout，工具参数与结果不截断，可直接 `jq` 消费。
  该模式下 stderr 的人读轨迹静默。

```bash
deepcode -p "统计一下这个仓库有多少个测试文件" --json | jq -r .text
deepcode -p "修掉这个 bug" --output-format stream-json | jq -c 'select(.type=="tool_start")'
```

### `--max-turns`

非法取值一律当场报错，不静默回落：

```bash
$ deepcode -p "任务" --max-turns 0
--max-turns 只接受正整数，收到：0
```

**为什么要报错**：步数预算写错了却按默认值跑完，事后无从分辨——所以宁可拒绝执行。

### `--trace`：请求侧轨迹

`stream-json` 给的是**模型说了什么**；请求侧轨迹给的是**我们说了什么**——系统提示词、被注入的提醒、
压缩后的历史、hook 输出，这些在输出流里一个都看不见。

```bash
deepcode -p "任务" --trace ./trace --yolo
diff ./trace/req-00007.json ./trace/req-00008.json   # 比对相邻两轮，看这一轮多塞了什么
```

每条记录带 `label` 区分场景：`turn`（正常轮次）/ `compact`（历史压缩）/ `recap`（会话摘要）/
`goal`（目标提取）/ `hook`（hook 内的模型调用）/ `classify`（auto 模式权限分类器）/
`memorySignal`（记忆信号门控）/ `memoryIndex`（记忆索引整合）/ `subagent:<类型>#<id>`（子代理）。

::: danger 落盘内容包含完整上下文
其中有 agent 读过的全部文件原文，**可能含密钥与私有代码**。目录以 `0700` 创建，但这是本地诊断
工具、不是日志——不要在共享环境常开，用完请自行删除。
:::

覆盖范围：记的是**所有有诊断价值的出站请求**，不是进程发出的全部请求。两处刻意不记——图片描述
（发的是图片，不是「deepcode 自己说的话」）与 key 校验探活（内容零诊断价值，落盘反而多一份敏感面）。

## 交互式参数

只在不带 `-p`、且 stdin 是终端时生效。

| 参数 | 说明 |
|---|---|
| `-c`, `--continue` | 继续上一次会话 |
| `--resume <file>` | 从指定会话文件恢复 |
| `--inline` | 用内联渲染而非全屏（等价于 `DEEPCODE_INLINE=1`） |

## 通用参数

| 参数 | 说明 |
|---|---|
| `--model <name>` | 本次启动用哪个模型，优先于 `settings.model` |
| `--permission-mode <mode>` | `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `yolo` |
| `--settings <path>` | 改用指定的 `settings.json` |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本号 |

### `--model`

仍受 `settings.availableModels` 白名单钳制——**不给命令行开后门**。被推翻时会在 stderr 告警，
并指明来源是 `--model` 而非 `settings.model`：

```bash
$ deepcode --model deepseek-v4-flash -p "任务"
[deepcode] --model=deepseek-v4-flash 不在 availableModels 白名单内，已回落到 deepseek-v4-pro
```

模型属于别家 provider 时同样会回落（防止被错投到当前 provider 的端点）。

### `--permission-mode`

| 取值 | 行为 |
|---|---|
| `default` | 按规则放行；需要批准时询问 |
| `acceptEdits` | `Edit`/`Write` 自动放行，其余照常 |
| `plan` | 只读模式，任何非只读工具一律拒绝 |
| `auto` | 规则未命中时交给分类器判 run/ask/block |
| `dontAsk` | 不弹窗，未预先批准的一律自动拒绝 |
| `yolo` | 全部放行 |

取值必须是上述六者之一，否则当场报错。**这层校验是必要的**：拼错一个字母会让权限判定的所有
分支都不命中，行为静默退化成 `default`——写 `--permission-mode yolo` 少打一个字母就变成全程
拒绝，而用户只会以为工具坏了。

`--yolo` 与一个不是 `yolo` 的 `--permission-mode` 同时给出时会报错，不让 `--yolo` 静默胜出。

::: warning auto 模式有额外开销
`auto` 每次工具调用会多一次分类器模型调用（约 3 秒 + 少量费用）。在 headless 与后台任务里同样生效。
:::

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 正常完成（headless 的 `status === 'done'`） |
| `1` | 未正常完成——撞步数上限、被中断、上下文超窗，或参数解析/启动报错 |

## 环境变量

### 模型 key

| | |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek |
| `ZHIPUAI_API_KEY` | GLM（智谱） |
| `MOONSHOT_API_KEY` | Kimi（Moonshot） |
| `DEEPCODE_API_KEY` | 自建 provider 的默认 key 变量名（可在 provider 配置里用 `apiKeyEnv` 改） |

优先级：环境变量 > `settings.json`。

### 行为开关

| | |
|---|---|
| `DEEPCODE_TRACE_DIR` | 等价于 `--trace <dir>` |
| `DEEPCODE_INLINE=1` | 等价于 `--inline` |
| `DEEPCODE_DISABLE_UPDATES=1` | **全关**：不查询、不提示，`/update` 也直接拒绝 |
| `DEEPCODE_DISABLE_AUTOUPDATER=1` | 只关自动升级，**仍会检查并提示** |
| `DEEPCODE_MAX_CONTEXT_TOKENS=<n>` | 覆盖按模型解析出的上下文窗口（压缩阈值随之改变） |
| `DEEPCODE_FLAGS='{"<flag>":true}'` | 实验性机制的开关，**默认全部关闭**。非法 JSON 会整体忽略并只警告一次 |

`DEEPCODE_DISABLE_UPDATES` 与 `DEEPCODE_DISABLE_AUTOUPDATER` 的取值判定一致：设为 `0` 或
`false` 视为未开启，其余非空值都算开启。

### 网络

`http_proxy` / `https_proxy` / `no_proxy`（大小写均可识别）。设置后 deepcode 自动经代理请求。

### 搜索 provider（`WebSearch` 工具用）

`BOCHA_API_KEY` / `TAVILY_API_KEY` / `ANYSEARCH_API_KEY`，按 settings 里配置的 provider 取用。

## 不面向用户的内部参数

`--background-run` / `--job <short>` 是 TUI 的 `/background` 拉起子进程时用的，不需要手动敲，
故不列入 `--help`。
