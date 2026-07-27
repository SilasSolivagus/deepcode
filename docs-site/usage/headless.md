---
title: headless
---

# headless

headless 模式跑完一个任务就退出，不进交互式 TUI，专为脚本、CI、批处理场景设计。

## 一次性运行：`-p`

```bash
deepcode -p "给 utils 补单测并跑通"
```

跟交互 TUI 是同一套主循环、同一批工具，唯一区别是没有界面：跑完直接把最终结果打到 stdout，工具调用过程（`⏺ Read(...)` 之类）打到 stderr，方便管道里只捕获结果本身。

不带 `-p` 但用管道喂 stdin 也会自动走 headless（把整段 stdin 当任务描述），适合 `echo "..." | deepcode` 这种用法，但只有 `-p` 支持下面的 `--output-format`。

## 输出格式：`--output-format`

用 `--output-format <text|json|stream-json>` 选输出形态（缺省 `text`）：

| 格式 | 输出 |
| --- | --- |
| `text`（缺省） | stdout 打最终回复文本；工具调用过程打到 stderr |
| `json` | stdout 打单条最终结果 JSON（见下方字段表），适合脚本读结果 |
| `stream-json` | stdout 逐行 JSONL 实时事件流（含完整工具参数与结果），适合机器解析全过程；该模式下 stderr 的 `⏺` 摘要静默，保证 stdout 是纯净 JSONL |

`--json` 是 `--output-format json` 的向后兼容别名；两者并存时 `--output-format` 优先。

### `json`：单条最终结果

```bash
deepcode -p "给 utils 补单测并跑通" --output-format json   # 或 --json
```

输出字段（对应源码 `HeadlessResult`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | `string` | 最后一条助手消息的文本 |
| `status` | `'done' \| 'aborted' \| 'max_turns'` | 结束原因，见下节退出码 |
| `turns` | `number` | 实际跑了几轮 |
| `usage` | `{ prompt_tokens, completion_tokens, prompt_cache_hit_tokens }` | 累计 token 用量 |
| `costCNY` | `number` | 本次调用花费（人民币） |

示例：

```jsonc
{
  "text": "utils.ts 里 4 个函数补了单测，npm test 跑通（12 passed）。",
  "status": "done",
  "turns": 3,
  "usage": { "prompt_tokens": 8123, "completion_tokens": 512, "prompt_cache_hit_tokens": 4096 },
  "costCNY": 0.03
}
```

### `stream-json`：实时事件流

逐行 JSONL 打到 stdout，每行一个独立事件，工具参数与结果**完整不截断**（仅受 `maxToolResultChars` 上限保护），适合在管道里实时解析 deepcode 读改了哪些文件、跑了哪些命令：

```bash
deepcode -p "给 utils 补单测并跑通" --output-format stream-json | jq -c 'select(.type == "tool_start") | {name, input}'
```

事件类型：

| `type` | 说明 |
| --- | --- |
| `init` | 首行一次：`session_id` / `cwd` / `model` / `yolo` |
| `text` | 助手文本增量（`delta`；`reasoning:true` 为思考增量） |
| `tool_start` | 工具开始：`id` / `name` / `input`（完整参数对象） |
| `tool_result` | 工具结束：`id` / `ok` / `content`（完整结果） / `ms` |
| `turn_end` | 一轮结束：累计 `usage` |
| `result` | 末行一次：字段同上方 `json` 的最终结果 |

每行都是独立合法 JSON，可 `jq -c` 逐行解析。

## 退出码

`process.exitCode` 只有两种取值：

- `status === 'done'` → **0**（成功跑完）。
- `status === 'aborted'` 或 `'max_turns'` → **1**（被 hook 拦截 / 中途中断 / 达到轮数上限）。
- 参数错误或抛出异常（比如 `-p` 后面没跟任务描述）同样落到 **1**。

`aborted` 和 `max_turns` 在退出码上不可区分，脚本要分辨具体原因就得读 `--json` 的 `status` 字段。

## 权限在非交互下

headless 没有人盯着屏幕点「允许」，所以内部的 ask 确认桩恒返回拒绝——凡是命中「需要询问」规则桶、又没被 allow 规则提前放行的操作，一律自动拒绝，绝不会真的弹出等待输入卡死进程。

放行破坏性操作（写文件外的命令、`git push` 之类）有两条路：

1. **`--yolo`**：整个会话按 `yolo` 权限模式跑，跳过确认桶。

   ```bash
   deepcode -p "跑测试并推一个修复分支" --yolo
   ```

2. **预置 allow 规则**：在 `settings.json` 的 `permissions.allow` 里精确匹配好要放行的命令模式，让检查在「允许」阶段就通过，根本不落到确认桶：

   ```jsonc
   {
     "permissions": {
       "allow": ["Bash(npm test)", "Bash(git push*)"]
     }
   }
   ```

注意：`--yolo` 不是万能钥匙——`permissions.deny` 规则、以及硬编码的「关键路径」防护（比如对 `rm` 之类破坏性命令的强制拦截）不受 `yolo` 影响，任何模式下都照样拦。

## CI / 脚本接入

用 `--json` + `jq` 断言结果，失败就让 CI 红：

```bash
#!/usr/bin/env bash
set -euo pipefail

result=$(deepcode -p "给 utils 补单测并跑通" --json --yolo)

status=$(echo "$result" | jq -r '.status')
cost=$(echo "$result" | jq -r '.costCNY')

if [ "$status" != "done" ]; then
  echo "任务未正常完成：status=$status" >&2
  exit 1
fi

echo "完成，花费 ¥$cost"
```

配合 `deepcode` 自身的退出码（见上节），也可以直接用 `deepcode -p "..." --yolo || exit 1` 这种更简单的写法，只是拿不到 `costCNY` 之类的明细。

---

下一步：[settings 与环境变量](/config/settings)、[权限模式](/usage/permissions)。
