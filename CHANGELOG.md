# 变更日志

本文件只记**用户能感知到的变化**。内部重构、测试、评测脚手架不在此列，完整历史见
[commit 记录](https://github.com/SilasSolivagus/deepcode/commits/main)。

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 未发布

### 新增
- `deepcode --help` / `-h` 与 `deepcode --version` / `-v`。此前敲 `--help` 会直接把 TUI 拉起来，
  在管道里则回一句「stdin 为空」——而这恰恰是装完之后第一个动作。

### 已知问题
- `--model` 与 `--permission-mode` 目前只对 `--background-run` 内部路径生效，
  `deepcode --model glm-5.2 -p "任务"` 里的 `--model` 会被静默忽略。故未列入 `--help`。

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
