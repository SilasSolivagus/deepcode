---
title: 交互 TUI
---

# 交互 TUI

deepcode 默认启动进交互式终端界面（TUI）。这一页讲清楚渲染器与视图模式怎么选、状态栏每一段是什么意思、核心键位有哪些、一轮完整交互长啥样。

## 两种渲染器：inline / fullscreen

`settings.json` 的 `tui` 字段只接受两个值：`"inline"` 或 `"fullscreen"`。不设置时走一条决策链，缺省结果是 **fullscreen**：

1. 后台会话（`/background`）→ 恒 `fullscreen`。
2. 非交互终端（无 TTY，比如管道/CI）→ `headless`，不进 TUI。
3. 命令行 `--inline` 传了 → `inline`。
4. `settings.tui` 设了值 → 直接用这个值。
5. 旧字段 `settings.inline === true`（向后兼容）→ `inline`。
6. 都没命中 → 缺省 `fullscreen`。

想固定用某一种，写死 `tui` 即可：

```jsonc
// ~/.deepcode/settings.json
{ "tui": "inline" }
```

或者单次启动加 `--inline`，不改配置文件。两种渲染器共享同一套主循环、工具与权限体系，纯粹是终端呈现方式不同——fullscreen 是 alt-screen 全屏+可滚动历史，inline 是普通终端顺序输出。

## 视图模式：default / focus

`viewMode` 字段接受 `"default"` 或 `"focus"`。设成 `"focus"` 时，启动即打开 focus 视图并**锁定**——工具调用的详细输出折叠收起，只留结论，界面更清爽；锁定状态下无法用命令临时关掉。

```jsonc
// ~/.deepcode/settings.json
{ "viewMode": "focus" }
```

两个相关命令：

- **`/tui <inline|fullscreen>`**——切换渲染器。会把新值写进 `settings.tui` 并重启一次子进程，当前会话历史原样恢复，只是换了呈现方式。
- **`/focus`**——切换 focus 视图的开关。只在 fullscreen 渲染器下可用；若被 `viewMode: "focus"` 锁定，`/focus` 不会生效，提示去 `settings.json` 里移除该字段并重启。

::: tip
inline 渲染器下 `/focus` 打不开——先 `/tui fullscreen` 切过去（会重启并恢复会话），再用 `/focus`。
:::

## 状态栏读法

输入框下方常驻一块多行状态栏，按簇从上到下：

**第 1 行——模型 / 模式 / 目录**

```
[deepseek-v4-pro | accept | think:medium] | my-project git:(main)
```

方括号里依次是当前模型、权限模式（状态栏显示 `default`/`auto`/`accept`/`plan`/`⏵⏵DONT-ASK`/`yolo`，详见[权限模式](/usage/permissions)）、开了 thinking 时追加的思考档位；方括号外是当前目录名与 git 分支（有则显示）；focus 视图打开时行尾会追加一个 `· focus` 徽标。

**第 2 行——上下文 / 缓存 / 花费**

```
Context 12k / 971k [██░░░░░░░░] · cache 62% (−¥0.0180) · ¥0.0320
```

- `Context used/window` 加一条 10 格迷你进度条：用量 ≥95% 变红、≥80% 变黄，其余是主题强调色。
- `cache N% (−¥x)` 只在本轮命中前缀缓存（hitRate > 0）时才出现，显示命中率与省下的钱。
- 设了 token 预算时会插入 `budget used/target` 段。
- 末尾 `¥花费` 是本会话累计花费，恒定颜色显示；累计超过 `costWarnCNY` 阈值时会额外弹出一条一次性花费提醒（toast 通知，不是状态栏变色）。
- 若配置了自定义 `statusLineCommand`，其 stdout 会作为单独一行附在这一簇下面。

**第 3 簇——记忆 / 工具计数 / 提示**

```
3 DEEPCODE.md
✓ Bash ×8 | ✓ Read ×4 | ✓ Edit ×2
/ 看命令 · @ 引用文件 · ! 跑 shell
```

生效的 `DEEPCODE.md` 指令文件数量（有才显示）、本会话已成功执行的工具按名字计数（有才显示）、以及恒定显示的一行操作提示。

## 核心键位

以下键位来自内置 `/keybindings` 命令，可随时在 TUI 里敲 `/keybindings` 查看：

| 分组 | 键位 | 行为 |
| --- | --- | --- |
| 输入框 | `Esc` | 生成中：中断当前回合；空闲：清空输入框 |
| 输入框 | `Enter` | 提交（补全菜单打开时由菜单接管） |
| 输入框 | 行尾 `\` + `Enter` | 续行，累积成多行输入 |
| 输入框 | `↑` / `↓` | 浏览历史输入（补全菜单打开时由菜单接管方向键） |
| 输入框 | `Backspace` / `Delete` | 删除字符 |
| 输入框 | `Tab` | 补全菜单导航/确认 |
| 滚动（仅 fullscreen） | `PageUp` / `PageDown` | 上/下翻页滚动历史 |
| 滚动（仅 fullscreen） | `Ctrl+G` | 跳到底部并恢复自动跟随 |
| 滚动 | 鼠标 / 触控板滚轮 | 上下滚动 |
| 退出 | `Ctrl+C` ×2（2 秒内） | 退出（会先等记忆写盘） |
| 触发 | `/` | 打开斜杠命令菜单 |
| 触发 | `@` | 打开文件引用菜单 |
| 触发 | `!` | 直跑一条 shell 命令 |
| 选中 | `Shift` + 拖拽 | 终端原生文本选中（滚轮已被程序捕获，需 `Shift` 才能走系统选区） |

另外两个键位不在 `/keybindings` 里，但源码里确认存在：

- **`Shift+Tab`**——循环切换权限模式（`default → auto → acceptEdits → plan → dontAsk → default`），详见[权限模式](/usage/permissions)；个别终端识别不到 `Shift+Tab` 时，用 `/plan`、`/accept`、`/dontask` 等命令兜底。
- **双击 `Esc`**（600ms 内、仅在空闲且输入框为空时）——打开 `/rewind` 回退选择器。

## 一轮交互长啥样

进 TUI 后直接说任务，deepcode 自己规划、调工具、跑测试，结束给一行成本结算：

```
› 给 utils 补单测并跑通

  Grep  搜索 utils 相关文件
  Read  src/utils.ts
  Edit  src/utils.test.ts
  Bash  npm test

  utils.ts 里 4 个函数补了单测，npm test 跑通（12 passed）。

  ¥0.03 · 3 turns · 8.2k tokens
```

生成过程中随时按 `Esc` 打断，或者直接在输入框敲字回车——会排队成下一句转向输入（steering）；若此时正有工具调用在执行，还会自动附带一次软中断。

---

下一步：[命令与快捷键](/usage/commands)、[权限模式](/usage/permissions)。
