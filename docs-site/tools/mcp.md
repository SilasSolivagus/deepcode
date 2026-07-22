---
title: MCP
---

# MCP

## MCP 是什么

Model Context Protocol（MCP）是外部工具服务器与 AI 应用之间的开放通信标准。deepcode 把它当作自己扩展工具集的方式：在 `settings.json` 里配好一个 MCP server，deepcode 就会连上它，把它暴露的工具动态接入内置工具池——不用改一行 deepcode 代码。当前只支持 stdio 传输，即以子进程方式在本机拉起的 server。

## 配置

MCP server 配在 `mcpServers` 字段下，每个 server 是一个 `command` + 可选 `args`/`env` 的对象，deepcode 会以 `command args...` 的方式拉起子进程做 stdio 握手：

```jsonc
// ~/.deepcode/settings.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

`env` 里的值支持 `${VAR}` 和 `${VAR:-默认值}` 形式的环境变量展开，连接时从当前进程环境取值填入子进程。握手（`connect`）有独立的 30 秒超时，拉取工具列表（`listTools`）另有一个独立的 30 秒超时——两段各计各的，极端情况下单个 server 最长可能耗时接近 60 秒；之后每次调用该 server 的工具有 120 秒超时。任一超时都只报该 server 的错，不影响其他 server。

`mcpServers` 属于敏感字段，只有 user 层（`~/.deepcode/settings.json`）才生效——project/local 层写了也会被剥离，详见 [settings](/config/settings)。

## 异步连接

交互式 TUI 下，deepcode 启动时不会等 MCP server 连完才进入可用状态：每个配置的 server 立刻被记为 `pending`，随后各自并行连接，互不阻塞，也不阻塞 TUI 启动。某个 server 连上后，状态翻成 `connected`，它暴露的工具立刻热插进共享工具池，当前会话马上就能调用；某个 server 连接失败（进程起不来、握手超时等），状态翻成 `failed` 并把错误信息作为警告提示出来，不会让启动崩溃，也不影响其他 server 继续连接或使用。

`-p` 一次性 headless 与后台会话（resume）走的是另一条路径：这两种模式会按配置顺序**逐个 `await` 连接**，全部连完（或各自超时/失败）才开始第一轮对话——也就是说非交互场景下 MCP 连接是同步阻塞的，不是热插模式。

## 资源工具

只要配置里有至少一个 MCP server，deepcode 就会把三个资源工具加进工具池（这三个是 deepcode 自带的，不是某个 server 提供的）：

| 工具 | 行为 |
| --- | --- |
| `ListMcpResources` | 列出已连接 server 暴露的资源，每条结果带 `server` 字段标明来源；可传 `server` 参数只列一个 server；不声明资源能力的 server 自动跳过，单个 server 出错也不影响其他 server 的结果 |
| `ReadMcpResource` | 按 `server` + `uri` 读取一个具体资源；文本内容直接内联返回；二进制内容落盘到临时目录并回传文件路径；资源不存在时返回可读的错误提示并建议重跑 `ListMcpResources` 刷新后再试；server 声明支持资源但未实现读取时，只返回对应的错误提示，不建议重跑 |
| `WaitForMcpServers` | 等待仍处于 `pending` 的 server 连接就绪（最多等 5 秒，每 50ms 轮询一次）；可传 `servers` 只等指定几个；返回 `ready`/`connected`/`failed`/`stillPending` 四个字段 |

## 权限

MCP server 自己声明的工具，其确认策略取决于该工具在 `tools/list` 里带的 `readOnlyHint` 标注：标了 `readOnlyHint: true` 的工具视为只读，deepcode 自动放行、不弹确认框；没标或标 `false` 的工具，每次调用前都需要你确认，标签形如「server 名: 工具名」，同样受权限模式/allow/deny/ask 规则约束。上面三个资源工具是 deepcode 自己的内置工具，恒为只读，不受这条规则影响。

---

`mcpServers` 字段的分层与剥离规则见 [settings](/config/settings)；内置工具全貌见 [工具总览](/tools/overview)。
