# deepcode × Terminal-Bench 适配器（turnkey）

把本地当前构建的 deepcode 作为 agent 接入 [Terminal-Bench](https://www.tbench.ai/)，产出可比榜单分数。照 `qwen_code` / `claude_code`（同为 node CLI）的 `AbstractInstalledAgent` 模式写成。

## 文件
- `deepcode_agent.py` —— `DeepcodeAgent`（`AbstractInstalledAgent`）：把 deepcode 装进任务容器、注入 provider/model/key、跑 `deepcode -p <task> --yolo`。
- `deepcode-setup.sh.j2` —— 容器内安装脚本：nvm 装 node 22（deepcode 需 ≥22.5）→ 从 host http 装本地 tarball → 写 `~/.deepcode/settings.json`。
- `run-tbench.sh` —— 一键：build+pack deepcode → 起 http 托管 tarball → `tb run`。

## 前置（干净环境）
- Docker 运行中；**国际网络可达 `registry.terminal-bench.ai`**（本仓库作者本机网络到该 registry 不通 HTTP 000，故需干净/境外网络环境）。
- `uv` 已装（`curl -LsSf https://astral.sh/uv/install.sh | sh`）。
- Node + 本仓库可 `npm run build`。
- API key：`DEEPSEEK_API_KEY`（deepseek 系）或 `GLM_API_KEY`（glm 系）。

## 跑
```bash
# deepseek-v4-pro，前 10 个任务
DEEPSEEK_API_KEY=sk-xxx ./eval/terminal-bench/run-tbench.sh deepseek-v4-pro 10

# glm-5.2 全量
GLM_API_KEY=xxx ./eval/terminal-bench/run-tbench.sh glm-5.2 0
```
（第二参数为任务数，`0`/省略视 tb 默认为全量。全量 ~80-100 任务 × 每容器装 node，耗时数小时 + API 花费。）

## 对齐榜单
`run-tbench.sh` 默认用 `-d terminal-bench-core`（=head 版本）。**要对齐公开 leaderboard，改成钉版本**，如 `-d terminal-bench-core==<leaderboard 版本号>`（见 tbench.ai leaderboard 页）。

## 已知点
- 首次会拉数据集（从 registry）+ 每任务建容器 + nvm 装 node，较慢。
- 若某任务容器非 Debian（无 apt），node 安装可能失败 → 该任务记 `AGENT_INSTALLATION_FAILED`（属环境非 deepcode 能力）。
- deepcode 配置在容器内 `~/.deepcode/settings.json`，记忆已关（`memory.enabled=false`）以隔离评测。
