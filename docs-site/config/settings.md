---
title: settings 与环境变量
---

# settings 与环境变量

deepcode 的配置分四层，最终合并成一份运行时 settings。本页讲清楚：文件放哪、怎么合并、哪些字段会被剥离、常用键有哪些、以及环境变量怎么用。

## 位置

| 层 | 路径 | 说明 |
| --- | --- | --- |
| user | `~/.deepcode/settings.json`（权限 600） | 个人全局配置，唯一可写 provider key 等敏感字段的层 |
| project | `<repo>/.deepcode/settings.json` | 随仓库提交，团队共享的项目级配置 |
| local | `<repo>/.deepcode/settings.local.json` | 项目内个人覆盖，通常加进 `.gitignore` 不提交 |
| flag | `--settings <path>` | 命令行显式指定的配置文件，优先级最高 |

## 分层合并

优先级为 **user < project < local < flag**：后一层的字段覆盖前一层同名字段；数组/对象字段则合并去重（比如两层都配了 `permissions.allow`，最终是并集），标量字段（比如 `model`）由最后写它的那一层生效。

想知道某个字段最终生效值来自哪一层，用 `/config` 查看——它会显示每个字段的来源层，多层共同贡献的数组/对象字段标为「merged」。

## 危险字段剥离

project 层配置随仓库分发，团队里任何人都能改，因此不能完全信任——一个恶意或被投毒的仓库不应该靠一份 `settings.json` 就篡改你的 API key、静默改写 hooks 去执行任意命令，或者关掉你的安全提示。所以 deepcode 在加载 project 层（以及被 git 跟踪、即被提交进仓库的 local 层）时，会整键剥离以下字段，只信任 user 层（或未被 git 跟踪的本地 local 层）里的同名配置：

```
apiKey、baseURL、hooks、mcpServers、webSearch、
allowedHttpHookUrls、httpHookAllowedEnvVars、
provider、providers、statusLineCommand、
autoModeModel、autoModeThinking、disableAutoMode、
language、cleanupPeriodDays、
attribution、includeCoAuthoredBy、
skillOverrides
```

以及三个嵌套字段：`permissions.allow`、`permissions.defaultMode`、`skills.sources`。

换句话说：project 层可以配 `permissions.deny`/`permissions.ask`（收紧权限没问题）、`worktree`、`viewMode` 之类的非敏感字段，但配不了 API key、hooks、MCP server、自定义状态栏命令这类能读密钥或执行代码的字段——这些只认 user 层（或者你自己写、没提交进仓库的 `settings.local.json`）。

同样，`/config` 会标出某个字段是否被剥离过（以及是哪一层被剥离），方便排查「为什么这个字段在项目里配了却不生效」。

## 常用键

不是完整字典，只列高频字段，完整清单见文末参考：

- `provider` / `providers`：当前 provider 后端 + 各家 apiKey（仅 user 层生效，详见[多 provider 配置](/config/providers)）。
- `permissions.allow` / `deny` / `ask` / `defaultMode`：权限规则与默认模式。
- `model`：启动默认模型（不设为内置缺省 `deepseek-v4-pro`）。
- `worktree`：git worktree 隔离相关配置（symlink 目录、sparse 路径）。
- `statusLineCommand`：自定义状态栏命令（仅 user 层）。
- `viewMode` / `tui`：`focus`/`default` 视图、`inline`/`fullscreen` 渲染模式。
- `costWarnCNY`：本会话花费提醒阈值（CNY）。

示例（`~/.deepcode/settings.json`）：

```jsonc
{
  "provider": "glm",
  "providers": {
    "glm": { "apiKey": "sk-..." }
  },
  "permissions": {
    "allow": ["Bash(npm test)"],
    "ask": ["Bash(git push*)"],
    "deny": ["Read(**/.env)"]
  },
  "model": "deepseek-v4-pro",
  "costWarnCNY": 15,
  "viewMode": "focus"
}
```

## 环境变量

各 provider 的 key 优先读环境变量，settings.json 里的 `apiKey`/`providers.*.apiKey` 是次优先兜底：

| 变量 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek key |
| `ZHIPUAI_API_KEY` | GLM·智谱 key |
| `MOONSHOT_API_KEY` | Kimi·Moonshot key |
| `DEEPCODE_API_KEY` | `custom` provider 缺省 key（可用 `apiKeyEnv` 改成别的变量名） |
| `BOCHA_API_KEY` / `TAVILY_API_KEY` | WebSearch 双源 key（优先于 `settings.webSearch`） |
| `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY` | 出站请求代理，自动读取无需额外配置 |

## SSRF 防护

hook 里的 HTTP 请求走两层防护：先过 `allowedHttpHookUrls` 白名单（不设=不限制，`[]`=全禁，非空则须匹配通配模式），再在网络层加一道 IP 守卫（拦截内网地址、DNS 重绑定），并禁止请求跟随重定向。有代理时代理接管 DNS 解析，守卫让位给代理。

---

完整字段参考见 [settings 参考](/reference/settings)。
