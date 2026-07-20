#!/usr/bin/env bash
# deepcode × Terminal-Bench 一键跑（干净环境用）。
# 前置：Docker 运行中 + 国际网络可达 registry.terminal-bench.ai + uv 已装 + 已 build 好 deepcode。
# 用法：
#   DEEPSEEK_API_KEY=sk-xxx ./run-tbench.sh deepseek-v4-pro 10
#   GLM_API_KEY=xxx        ./run-tbench.sh glm-5.2 10
set -euo pipefail

MODEL="${1:-deepseek-v4-pro}"
N_TASKS="${2:-10}"
PORT="${TARBALL_PORT:-8899}"
ADAPTER_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$ADAPTER_DIR/../.." && pwd)"

echo "==> 构建 + 打包本地 deepcode"
(cd "$REPO_DIR" && npm run build >/dev/null && npm pack >/dev/null)
TARBALL="$(ls -t "$REPO_DIR"/*.tgz | head -1)"
echo "    tarball: $TARBALL"

echo "==> 起 http 服务托管 tarball（供容器 curl）"
SERVE_DIR="$(dirname "$TARBALL")"
( cd "$SERVE_DIR" && python3 -m http.server "$PORT" >/tmp/dc-tarball-http.log 2>&1 ) &
HTTP_PID=$!
trap 'kill $HTTP_PID 2>/dev/null || true' EXIT
sleep 1
TARBALL_URL="http://host.docker.internal:${PORT}/$(basename "$TARBALL")"
echo "    URL: $TARBALL_URL"

echo "==> tb run（模型=$MODEL，任务数=$N_TASKS）"
PYTHONPATH="$ADAPTER_DIR" DEEPCODE_TARBALL_URL="$TARBALL_URL" DEEPCODE_MODEL="$MODEL" \
  uvx --from terminal-bench tb run \
    -d terminal-bench-core \
    --agent-import-path deepcode_agent:DeepcodeAgent \
    -k "tarball_url=$TARBALL_URL" \
    -m "$MODEL" \
    --n-tasks "$N_TASKS" \
    --n-concurrent 4 \
    --output-path "$REPO_DIR/tbench-runs"

echo "==> 结果在 $REPO_DIR/tbench-runs"
