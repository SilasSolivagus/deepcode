---
title: MCP
---

# MCP

## What MCP is

The Model Context Protocol (MCP) is an open communication standard between external tool servers and AI applications. deepcode uses it to extend its own tool set: configure an MCP server in `settings.json`, and deepcode connects to it and dynamically merges the tools it exposes into the built-in tool pool — no deepcode code changes required. Only stdio transport is supported today, i.e. servers spawned as a local subprocess.

## Configuration

MCP servers are configured under the `mcpServers` field, each entry a `command` plus optional `args`/`env`; deepcode spawns the subprocess as `command args...` and does the stdio handshake:

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

Values in `env` support `${VAR}` and `${VAR:-default}` expansion, resolved from the current process environment at connect time. Connecting to a single server has a 30-second timeout (handshake plus fetching its tool list); after that, each call to one of its tools has a 120-second timeout — timeouts error out without affecting other servers.

`mcpServers` is a sensitive field: it only takes effect from the user layer (`~/.deepcode/settings.json`) — project/local layers get it stripped even if they set it. See [settings](/en/config/settings).

## Async connection

deepcode doesn't wait for MCP servers to finish connecting before it becomes usable at startup: every configured server is immediately marked `pending`, then each connects in parallel without blocking anything, including TUI startup. Once a server connects, its status flips to `connected` and the tools it exposes are hot-inserted into the shared tool pool right away — usable in the current session immediately. If a server fails to connect (process won't spawn, handshake times out, etc.), its status flips to `failed` and the error is surfaced as a warning; it never crashes startup or blocks other servers from connecting and being used.

## Resource tools

As long as at least one MCP server is configured, deepcode adds three resource tools to the tool pool (these are deepcode's own, not provided by any server):

| Tool | Behavior |
| --- | --- |
| `ListMcpResources` | Lists resources exposed by connected servers, each result tagged with a `server` field; an optional `server` argument scopes it to one server; servers that don't declare resource capability are skipped, and one server erroring doesn't affect the others' results |
| `ReadMcpResource` | Reads a specific resource by `server` + `uri`; text content is returned inline; binary content is saved to a temp file and its path is returned; a missing resource or a server that doesn't implement resource reads returns a readable error suggesting you re-run `ListMcpResources` to refresh |
| `WaitForMcpServers` | Waits for servers still `pending` to finish connecting (up to 5 seconds, polling every 50ms); an optional `servers` argument scopes it to specific servers; returns `ready`/`connected`/`failed`/`stillPending` fields |

## Permissions

For tools a server declares itself, whether deepcode asks for confirmation depends on the `readOnlyHint` annotation returned in `tools/list`: a tool marked `readOnlyHint: true` is treated as read-only and auto-runs without a confirmation prompt; one that's unmarked or `false` requires confirmation before every call, labeled `serverName: toolName`, subject to the usual permission-mode/allow/deny/ask rules. The three resource tools above are deepcode's own built-in tools and are always read-only, unaffected by this rule.

---

Layering and stripping rules for `mcpServers` are covered in [settings](/en/config/settings); the full built-in tool list is in [Tools overview](/en/tools/overview).
