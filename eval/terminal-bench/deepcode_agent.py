"""Terminal-Bench 适配器：把本地当前构建的 deepcode 装进任务容器并运行。
照 qwen_code / claude_code（同为 node CLI）模式。deepcode 走 OpenAI 兼容后端
（deepseek / glm），配置写入容器内 ~/.deepcode/settings.json。"""
import json
import os
import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


def _real_settings() -> dict:
    try:
        return json.loads(
            Path(os.path.expanduser("~/.deepcode/settings.json")).read_text()
        )
    except Exception:
        return {}


class DeepcodeAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "deepcode"

    def __init__(self, model_name: str | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # -m 可能传 "provider/model" 格式，取最后一段
        raw = model_name or os.environ.get("DEEPCODE_MODEL", "deepseek-v4-pro")
        self._model_name = raw.split("/")[-1]
        self._tarball_url = kwargs.get("tarball_url") or os.environ.get("DEEPCODE_TARBALL_URL")
        if not self._tarball_url:
            raise ValueError("需要 tarball_url：-k tarball_url=http://host.docker.internal:PORT/xxx.tgz")

        self._provider = "glm" if self._model_name.startswith("glm") else "deepseek"

        rs = _real_settings()
        if self._provider == "glm":
            self._api_key = (
                kwargs.get("api_key")
                or os.environ.get("GLM_API_KEY")
                or os.environ.get("ZHIPU_API_KEY")
                or (rs.get("providers", {}).get("glm", {}) or {}).get("apiKey")
            )
        else:
            self._api_key = (
                kwargs.get("api_key")
                or os.environ.get("DEEPSEEK_API_KEY")
                or rs.get("apiKey")
                or (rs.get("providers", {}).get("deepseek", {}) or {}).get("apiKey")
            )
        if not self._api_key:
            raise ValueError(f"{self._provider} 缺 api_key（-k api_key= 或环境变量）")

    def _build_settings(self) -> str:
        s = {"provider": self._provider, "model": self._model_name, "memory": {"enabled": False}}
        if self._provider == "glm":
            s["providers"] = {"glm": {"apiKey": self._api_key}}
        else:
            s["apiKey"] = self._api_key
        return json.dumps(s, ensure_ascii=False)

    @property
    def _env(self) -> dict:
        return {}

    def _get_template_variables(self) -> dict:
        return {"tarball_url": self._tarball_url, "settings_json": self._build_settings()}

    @property
    def _install_agent_script_path(self) -> Path:
        return self._get_templated_script_path("deepcode-setup.sh.j2")

    def _run_agent_commands(self, task_description: str) -> list[TerminalCommand]:
        esc = shlex.quote(task_description)
        return [
            TerminalCommand(
                command=f"deepcode -p {esc} --yolo",
                max_timeout_sec=float("inf"),
                block=True,
            )
        ]
