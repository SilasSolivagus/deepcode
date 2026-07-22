---
title: 权限模式
---

# 权限模式

工具调用要不要弹窗确认、弹了之后怎么判，由「权限模式」决定。deepcode 共有六种模式，`Shift+Tab` 在其中五种间循环切换，页脚会展示当前模式标签。本页讲清楚模式怎么选、优先级怎么排；具体的 `permissions.allow`/`ask`/`deny` 规则字段配置见 [settings](/config/settings)。

## 六个模式

| 模式 | 用途 |
| --- | --- |
| `default` | 默认模式：写操作、危险操作按 allow/ask/deny 规则逐条确认。 |
| `acceptEdits` | Edit/Write 自动放行免确认，Bash 等其它操作仍需确认。 |
| `yolo` | 几乎全部放行，不弹确认框；只能通过启动参数 `--yolo` 开启，不参与 `Shift+Tab` 循环。 |
| `plan` | 只读模式：只能探索与写计划，任何非只读操作都会被拒绝，需调用 `ExitPlanMode` 才能把计划落地为实际改动。 |
| `auto` | 交给分类器自动判定放行 / 询问 / 拦截，只读操作免审；连续或累计判高风险会熔断，退回来问你。 |
| `dontAsk` | 不弹确认框：只读操作放行，任何原本需要确认的写操作一律自动拒绝（不是自动放行）。 |

`/plan`、`/accept`、`/dontask` 三个模式有对应的打字命令可以直接切入退出；`auto` 与 `yolo` 没有打字命令——`auto` 只能靠 `Shift+Tab` 循环进入，`yolo` 只能靠启动参数开启。

## Shift+Tab 循环

`Shift+Tab` 在五个模式间循环（`yolo` 不在循环里）：

```
default → auto → acceptEdits → plan → dontAsk → default
```

每次切换后页脚会更新标签：`default`、`auto`、`accept`（对应 `acceptEdits`）、`plan`、`⏵⏵DONT-ASK`（对应 `dontAsk`）。`yolo` 没有对应的页脚循环态，它只在启动时以 `--yolo` 参数生效。

## 优先级

`checkPermission` 按以下顺序判断，越靠前优先级越高：

1. **deny 规则最高**——命中 deny 即拒绝（Bash 命令命中时降级为强制确认而非直接拒绝，其它工具直接拒绝）。这一判断早于只读短路、`yolo`、`acceptEdits`、allow/ask 规则，任何模式都不能绕过。
2. **系统级安全兜底**——例如 `rm`/`rmdir` 打到关键系统路径或当前工作目录，即使处于 `yolo` 模式也必须显式确认；这类兜底不经过权限规则判断，`yolo` 不能绕过。
3. **只读工具 / `yolo` / `acceptEdits`**——只读操作直接放行；`yolo` 放行几乎全部操作；`acceptEdits` 只对 `Edit`/`Write` 放行，其余操作仍走后续规则。
4. **allow / ask 规则**——命中 allow 规则放行；命中 ask 规则强制弹窗确认，即使同时命中 allow 规则或处于 `yolo` 模式，ask 规则依然生效。
5. **`auto` 模式分类器**——以上都没命中时，由分类器判定放行 / 询问 / 拦截。

`dontAsk` 不参与上述判断链——它在需要弹窗确认的那一刻直接判定为拒绝，行为上等价于「只读放行、写操作全拒」。

## plan 模式只读

`plan` 模式下任何非只读工具调用都会被直接拒绝，不会进入 allow/ask 判断。想让计划真正落地为文件改动，需要调用 `ExitPlanMode` 请你审批；审批通过后才会退出只读限制。

## 查看已保存的规则

`/permissions` 查看当前生效的 allow/ask/deny 规则列表及每条规则的来源层级，也可以用 `/permissions rm <编号>`、`deny-rm <编号>`、`ask-rm <编号>` 删除某条规则。

## 规则字段配置

`permissions.allow`/`ask`/`deny` 这几个规则字段怎么写、放在哪一层配置文件里，见 [settings](/config/settings)，本页只讲交互模式本身。

---

下一步：[settings 与环境变量](/config/settings)。
