# 变更日志

本文件只记**用户能感知到的变化**。内部重构、测试、评测脚手架不在此列，完整历史见
[commit 记录](https://github.com/SilasSolivagus/deepcode/commits/main)。

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.14.0 — 2026-08-04

### 新增
- `deepcode --help` / `-h` 与 `deepcode --version` / `-v`。此前敲 `--help` 会直接把 TUI 拉起来，
  在管道里则回一句「stdin 为空」——而这恰恰是装完之后第一个动作。

### 修复
- **`--model` 此前在 headless 与交互式下被静默忽略**，只对 `--background-run` 内部路径生效。
  `deepcode --model glm-5.2 -p "任务"` 会按 settings 里的模型跑完、按那个模型计费、一声不吭。
  自仓库第一个 commit 起就是如此。现已接到全部三条路径，仍受 `availableModels` 白名单钳制，
  被推翻时告警会指明来源是 `--model` 而非 `settings.model`。
- `--model` 取值缺失或以 `-` 开头现在当场报错。此前 `deepcode --model -p "任务"` 会把 `-p`
  当成模型名读走，再给出一句指向用户从没写过的「模型名」的告警。

- **`--permission-mode` 此前在 headless 与交互式下被静默忽略**，且从来没有任何取值校验
  （拼错一个字母会让权限判定的所有分支都不命中，行为静默退化成 `default`）。现已接到全部三条
  路径，取值必须是 `default|acceptEdits|yolo|plan|auto|dontAsk` 之一，否则当场报错。
- **`auto` 模式在 headless 与后台任务里是失效的**：权限判定的 auto 分支要求提供分类器，而只有
  交互式 TUI 提供了。由于 `/background` 会把当前权限模式传给后台子进程，**在 auto 模式下开的
  后台任务实际跑在 `default` 下，需要权限的工具全被拒且没有任何提示**。现已给两条路径都接上
  分类器。⚠️ `auto` 每次工具调用会多一次分类器模型调用（约 3 秒 + 少量费用）。
- `--yolo` 与一个不是 `yolo` 的 `--permission-mode` 同时给出时现在报错。此前是 `--yolo` 静默
  胜出——用户以为自己设了 `plan`，实际全程放行。

## 0.13.0 — 2026-08-04

### 新增
- **请求侧轨迹**：`--trace <dir>` / `DEEPCODE_TRACE_DIR`，把发给模型的每个请求原样落盘为
  `<dir>/req-NNNNN.json`。stream-json 给的是模型说了什么，这个给的是**我们说了什么**——
  系统提示词、注入的提醒、压缩后的历史、hook 输出，都在输出流里看不见。仅 `-p` 与管道生效。
  ⚠️ 落盘内容含完整上下文（可能有密钥与私有代码），目录以 `0700` 创建，用完请自行删除。
- `--max-turns <n>`：覆盖 settings 里的 headless 步数预算。非法取值当场报错，不静默回落。

### 变更
- 实验性机制统一由 `DEEPCODE_FLAGS` 环境变量门控，**默认全部关闭**。这样做 A/B 对照时
  两臂跑的是同一份代码、同一个进程形态，唯一差异是这个环境变量。

## 0.12.0 — 2026-07-31

### 新增
- 逐轮上下文压缩接到 headless 与 TUI 两条路径，长任务不再因为超窗中断。

## 0.11.0 — 2026-07-31

### 新增
- headless 与交互式的能力对齐第一步：thinking 开关与步数预算可配（`headlessMaxTurns`），
  上下文超窗时反应式恢复而非直接失败。

## 0.10.0 — 2026-07-27

### 新增
- **自动升级子系统**：npm 全局安装可直接自动升级，其余安装形态只在页脚提示升级命令。
  `/update` 手动检查，`DEEPCODE_DISABLE_UPDATES=1` 全关。
- `/` 菜单给技能加来源标签，区分技能与内置命令。

## 0.9.2 — 2026-07-20

### 新增
- **支持 Kimi（Moonshot）**：内置 `kimi-k3` / `kimi-k2.7-code` / `k2.6` / `k2.5`。

### 修复
- 成本累计出现 `¥NaN`。
- `--settings` 未全局穿透，导致运行期计价/provider 归属与 client 割裂。
- 成本核算补齐盲区：分类器、识图、索引归纳的用量此前不计入会话成本。

## 0.8.0 及更早

编排地基（类型化子代理、后台任务）、权限模型、记忆系统、MCP/Skills/Hooks 生态等。
详见 [commit 记录](https://github.com/SilasSolivagus/deepcode/commits/main) 与
[Releases](https://github.com/SilasSolivagus/deepcode/releases)。
