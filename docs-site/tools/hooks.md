---
title: Hooks
---

# Hooks

## Hooks 是什么

Hooks 是挂在 deepcode 生命周期各个节点上的外部命令（默认是 shell 命令）。某个事件触发时，deepcode 按配置里的 matcher 找到匹配的挂载点并发起调用，可以借此做审计记录、拦截危险操作、在特定节点追加上下文，或者联动外部系统（CI、IM 通知、自定义脚本）——完全不用改 deepcode 代码本身。

## 事件类型

deepcode 定义了以下事件（`src/hooks.ts` 的 `HOOK_EVENTS` 全量枚举）：

| 事件 | 何时触发 |
| --- | --- |
| `PreToolUse` | 工具调用执行前 |
| `PostToolUse` | 工具调用成功完成后 |
| `PostToolUseFailure` | 工具调用出错/失败后 |
| `PostToolBatch` | 一批并行工具调用全部结束后 |
| `PermissionRequest` | 弹出权限确认前 |
| `PermissionDenied` | 一次权限请求被拒绝后 |
| `SessionStart` | 会话启动时 |
| `SessionEnd` | 会话结束时 |
| `Setup` | 首次运行/维护性初始化（比如写入默认配置）时 |
| `UserPromptSubmit` | 用户提交一条 prompt 时 |
| `UserPromptExpansion` | 一个自定义命令/prompt 展开后 |
| `Stop` | 一轮对话（agent 回合）正常结束时 |
| `StopFailure` | 一轮对话异常结束时 |
| `SubagentStart` | 一个子代理启动时 |
| `SubagentStop` | 一个子代理结束时 |
| `PreCompact` | 上下文压缩（compact）执行前 |
| `PostCompact` | 上下文压缩执行后 |
| `TaskCreated` | 一个任务（后台命令/子代理/todo）被创建时 |
| `TaskCompleted` | 一个任务完成/结束时 |
| `MessageDisplay` | 一条消息即将展示给用户前 |
| `Notification` | 触发一次系统通知时 |
| `ConfigChange` | 会话中配置发生变更时 |
| `CwdChanged` | 工作目录发生变化时（比如 Bash 工具里 `cd`） |
| `InstructionsLoaded` | DEEPCODE.md 一类的项目指令被加载时 |
| `WorktreeCreate` | 创建/进入一个 git worktree 时 |
| `WorktreeRemove` | 移除/退出一个 git worktree 时 |
| `Elicitation` / `ElicitationResult` | 预留给未来的交互式征询子系统，当前尚未派发 |
| `TeammateIdle` | 预留给未来的多 agent 协作子系统，当前尚未派发 |
| `FileChanged` | 预留给未来的文件监听子系统，当前尚未派发 |

## matcher 匹配

每个事件下可以配多组 `{ matcher, hooks }`，matcher 决定这组 hook 对当次触发是否生效，按以下优先级判断：

1. **恒真**：`matcher` 未设置、为空字符串、或为 `"*"` —— 永远匹配。
2. **管道或**：包含 `|` 时按 `|` 切分成多个候选，命中任意一个即匹配（比如 `"Bash|Read"` 匹配工具名为 `Bash` 或 `Read` 的调用）。
3. **精确标识符**：纯 `[A-Za-z0-9_]+` 时按字符串精确相等匹配。
4. **正则**：以上都不满足时当作正则表达式匹配；出于 ReDoS 防御，超过 200 字符的 matcher 直接判不匹配（构造正则本身失败同样判不匹配），不会真的拿去跑。

matcher 匹配的目标字段随事件而定：

| 匹配字段 | 适用事件 |
| --- | --- |
| `tool_name` | `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied` |
| `source` | `SessionStart`、`ConfigChange` |
| `trigger` | `Setup`、`PreCompact`、`PostCompact` |
| `agent_type` | `SubagentStart`、`SubagentStop` |
| `notification_type` | `Notification` |
| `reason` | `SessionEnd` |
| `error` | `StopFailure` |
| `command_name` | `UserPromptExpansion` |
| `load_reason` | `InstructionsLoaded` |
| `file_basename` | `FileChanged` |
| （无） | 其余事件不参与 matcher 过滤，恒匹配该事件下配置的所有 hook |

## 配置

在 settings.json 的 `hooks` 字段下按事件名分组，每组是一个 `{ matcher, hooks }` 数组：

```jsonc
// ~/.deepcode/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write",
        "hooks": [
          { "type": "command", "command": "echo \"about to run: $TOOL_NAME\" >> /tmp/audit.log", "timeout": 5000 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "say 完成啦", "async": true }
        ]
      }
    ]
  }
}
```

除了最常用的 `type: "command"`（跑一条 shell 命令，字段有 `command`/`timeout`/`async`）之外，还支持三种类型：`type: "prompt"`（丢给一次 LLM 判定，字段 `prompt`/`model`）、`type: "agent"`（跑一个只读子代理多轮核查，字段同 `prompt`/`model`）、`type: "http"`（打一个 HTTP 请求，字段 `url`/`headers`/`allowedEnvVars`）。command hook 的退出码决定结果：非 0 视为出错，`2` 视为阻断（block）当次操作；标准输出如果是一段 JSON，会按约定字段（比如 `decision`、`hookSpecificOutput.permissionDecision`）进一步影响权限判定和上下文注入。`async: true` 把命令交给后台执行、不阻塞当前流程。

## 安全

- **http hook 的 SSRF 防护**：`type: "http"` 发起的请求先过 `allowedHttpHookUrls` 白名单（不设=不限制，`[]`=全部禁止，非空则须匹配通配模式），再在网络层加一道 IP 守卫拦截内网地址和 DNS 重绑定，并禁止跟随重定向，与 WebSearch 共用同一套防护。
- **project 层剥离**：`hooks` 本身、以及与它配套的 `allowedHttpHookUrls`、`httpHookAllowedEnvVars`，都在危险字段剥离名单里——项目仓库里的 `.deepcode/settings.json`（以及被 git 跟踪的 `settings.local.json`）就算配了 `hooks` 也不会生效，只有 `~/.deepcode/settings.json`（或你自己未提交进仓库的本地覆盖）里的 hooks 才会被执行。这样即使克隆到一个恶意仓库，也不会被静默塞进任意命令执行。

---

`hooks`/`allowedHttpHookUrls`/`httpHookAllowedEnvVars` 字段的分层与剥离规则见 [settings](/config/settings)；内置工具全貌见 [工具总览](/tools/overview)。
