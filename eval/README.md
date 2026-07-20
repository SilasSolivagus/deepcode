# deepcode eval harness

防污染自造场景 × 多模型 × N seeds 的可复现能力评测，程序化判分，出 **pass^N（可靠性）** + 成本/耗时矩阵。零 Docker、走 deepcode headless。

## 用法
```bash
node eval/run.mjs [--models a,b,c] [--seeds N] [--scenarios id,id] [--out file.json]
```
默认：`--models deepseek-v4-pro,deepseek-v4-flash,glm-5-turbo --seeds 3`（跑全部场景）。

每格：隔离 HOME（钉 provider+model、关记忆）里 fresh 工作目录 → `deepcode -p <prompt> --json --yolo` → 程序化 `verify()`。API key 从真实 `~/.deepcode/settings.json` + 环境变量继承。

## 场景（全部客观可判）
| id | 压什么 | 判分 |
|---|---|---|
| `bugfix` | 定位+修单 bug | 修完 `average([2,4,6])===4` |
| `refactor` | 跨文件抽公共函数 | validate.mjs 导出 + 两处 import + 无残留 + 行为对 |
| `recovery` | 工具失败自愈 | 修完 `node --test` 全过 |
| `evaluator` | 复杂编程（parser） | 导出 `evaluate(expr)` + 9 刁钻用例全对 |
| `log-analysis` | 非编程·数据分析 | analysis.md 命中预埋异常（暴力破解 IP + checkout 500）+ 数字 |

主观题（office 文档 / 联网研究 / 模糊需求）v1 未收，留给将来的 rubric + LLM-judge 扩展。

## 读结果
- `pass^N`（表里 `★`）= N 次全过 = 可靠；`passN/N` = 通过次数。
- 矩阵每格：`通过数/N ¥平均成本 平均秒数`。
- 完整明细在 `--out` 的 JSON（每次 run 的 pass/detail/turns/cost/status）。

## 将来扩展
多加模型/seeds；接 rubric+LLM-judge 判主观题；失败分类学；接 Terminal-Bench 出对外可比数字。
