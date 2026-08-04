// src/help.ts
// `deepcode --help` 的正文。
//
// ⚠️ 只列真正在用户可达路径上生效的参数。`--model` 与 `--permission-mode` 目前只被
// `--background-run`（TUI 的 /background 拉起的内部子进程）消费，在 `-p` 与交互式下
// 是静默忽略的——写进帮助就是骗人，故刻意不列。等它们真接上去再加。
import { VERSION } from './version.js'

export const HELP = `deepcode ${VERSION} — 直连 DeepSeek / GLM / Kimi 的终端编码 agent

用法：
  deepcode                        交互式 TUI（首次运行会引导配置 API key）
  deepcode -p "<任务>"             一次性 headless 输出
  echo "<任务>" | deepcode         管道喂入，同样走 headless

headless 参数（配合 -p 或管道使用）：
  --output-format <fmt>           text（默认）| json | stream-json
  --json                          等价于 --output-format json
  --max-turns <n>                 本次跑的最大轮次，正整数，覆盖 settings 里的默认值
  --trace <dir>                   把发给模型的每个请求原样落盘为 <dir>/req-NNNNN.json
                                  ⚠️ 含完整上下文（可能有密钥与私有代码），仅供本地诊断
  --yolo                          跳过所有权限询问

交互式参数：
  -c, --continue                  继续上一次会话
  --resume <file>                 从指定会话文件恢复
  --inline                        用内联模式而非全屏（等价于 DEEPCODE_INLINE=1）

通用：
  --settings <path>               改用指定的 settings.json
  -h, --help                      显示本帮助
  -v, --version                   显示版本号

环境变量：
  DEEPSEEK_API_KEY / ZHIPUAI_API_KEY / MOONSHOT_API_KEY   模型 key
  DEEPCODE_TRACE_DIR              等价于 --trace
  DEEPCODE_DISABLE_UPDATES=1      关闭后台版本检查
  https_proxy                     需要走代理时设置

文档：https://deepcode.dirctable.com/docs
仓库：https://github.com/SilasSolivagus/deepcode`
