# dsh-finish-line

> 一句话：任务会话结束、排队输入清空后，自动串行执行两步收尾——先把公共函数收进公共模块，再分批审 diff、提交、推送。

[简体中文](README.md) · [English](README.en.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-9-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

一个 DeepSeek Harness（DSH）插件。模型写完功能常常停在半路：公共函数散在各处，改动没提交，diff 没人审。收尾不在一轮任务的目标范围内，本插件把它挪到回合结束之后单独执行。

## 触发条件

以下四条同时满足才启动：

- 会话所在目录是 Git 仓库，且有改动。
- 本会话至少发生过一次工具调用。纯问答不触发。
- `turn/end` 之后静默 `quietMs`（默认 20 秒）。
- 该会话的排队输入已清空。

## 工作方式

```
turn/end ──▶ 静默 20s ──▶ 排队输入清空 ──▶ 判定：Git 仓库 && 有改动 && 调过工具
                                                    │
                                                    ▼
                                      子代理 A：组件化整理
                                                    │ await result
                                                    ▼
                                      子代理 B：批判提交
                                                    │
                                                    ▼
                                                 链完成
```

- 判定通过后启动子代理 A，执行「组件化整理」：把 `git diff` 里的公共函数收进 utils / 公共模块。
- A 结束后启动子代理 B，执行「批判提交」：调 `cc-git-commit` 分批审 diff、提交、推送。
- 两步各是一句原话，在 `stages` 里配置。子代理从空对话开始，只收到这一句，自己看 `git diff`，结合仓库上下文干活。
- 不传 `agentOptions`，子代理继承父会话的 provider / model / 推理档，不会被 profile 的默认值降级。
- 一条链只跑一次。链状态落盘，DSH 重启后从状态文件恢复，不会重开。
- 任务会话里 AI 提问时回合不结束，收尾链不会启动；它不替你回答。

## 快速开始

```sh
# 1. 克隆到 ~/.dsh/plugins/dsh-finish-line
git clone https://github.com/gpboyer2/dsh-finish-line.git ~/.dsh/plugins/dsh-finish-line

# 2. 注册到 profile（命令行管理的 profile，如 web / main）
dsh plugin --profile <你的profile> add link:$HOME/.dsh/plugins/dsh-finish-line

# 3. 完整重启 DSH —— Host 插件只在启动时加载
```

`desktop` profile 由 DeepSeek Harness.app 独占，命令行会被拒。桌面版手动三步：在 `~/.dsh/profiles/desktop/node_modules/` 下建同名软链、`package.json` 的 `dependencies` 加 `"dsh-finish-line": "link:/绝对路径"`、`dsh.profile.bundles` 末尾加 `"dsh-finish-line"`，再重启。在应用内「插件」页安装也一样。

包内的 `cordis.patch.yml` 自动插入插件行并把执行器设为 `subagent`，不用手改 profile 的 patch 文件。

验证：在一个有改动的 Git 仓库里让 AI 干一件带工具调用的小活。等 20 秒，看 `~/.dsh/logs/finish-line.log` 是否出现「启动收尾链」，以及两步的「子代理已启动 / 结束」。

首次安装建议先 `dryRun: true`：只写日志、不动代码，确认触发时机后再关掉。

## 核心功能

| 能力 | 说明 |
| --- | --- |
| 自动触发 | 四条触发条件同时满足才动手，不做模糊判断。 |
| 两步串行 | 前一步的子代理结束后才启下一步；顺序在 `stages` 里改。 |
| 空对话子代理 | 不继承聊天记录、不预置人格、不塞上下文。 |
| 模型继承 | `agentOptions: null`，沿用父会话的模型与推理档。 |
| 两种执行器 | `subagent`（默认，侧栏不列）或 `session`（两个新会话，侧栏可见）。 |
| 按需请人格 | 只在子代理汇报「定不了 / 需要拍板」时调一次人格模型，平时零开销。 |
| 断点恢复 | 链状态落盘，保留 7 天、最多 300 条。 |
| dry-run | 只写判定与日志，不启子代理、不改代码。 |
| 零依赖 | 只用 DSH 注入的宿主服务与 Node 内置模块。 |

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里覆盖插件行的 `config:`：

```yaml
- id: finish-line
  name: dsh-finish-line
  config:
    enabled: true
    executor: subagent      # subagent | session
    dryRun: false
    quietMs: 20000
    requireToolCall: true
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。 |
| `executor` | `subagent` | `subagent`：进程内 spawn，空对话，侧栏不列；`session`：两个全新顶层会话，侧栏可见。 |
| `dryRun` | `false` | 只写日志、不真跑。 |
| `quietMs` | `20000` | `turn/end` 之后的静默窗口。 |
| `requireToolCall` | `true` | 本会话至少一次工具调用才触发。 |
| `maxChainAgeMs` | `21600000` | 一条链最长存活 6 小时，超时不再恢复。 |
| `gitTimeoutMs` | `8000` | `git status` / `git diff` 的单次超时。 |
| `stages` | 两句原话 | `[{ id, titlePrefix, prompt }]`，每步一句，顺序与文案都在这里改。 |
| `subagent.provider` | `spawn` | 进程内子代理后端名。 |
| `subagent.agentOptions` | `null` | `null` = 不传，继承父会话模型。 |
| `subagent.decideOnStuck` | `true` | 卡住时才请人格。 |
| `subagent.decideKeywords` | 见源码 | 哪些话算「定不了」。 |
| `subagent.decideMaxWaitMs` | `600000` | 拍板发回后等它这一轮的上限。 |
| `persona.enabled` | `true` | 人格代答 / 拍板总开关。 |
| `persona.provider` / `model` | `magpie` / `local-31-99/qwen3.8-27b` | 代答用的模型路由。 |
| `persona.file` | `~/.dsh/finish-line.persona.md` | 人格文件；不存在时用内置的一份。 |
| `logFile` | `~/.dsh/logs/finish-line.log` | 日志位置。 |

内置人格是「直接、最小改动、拒绝假兼容、分批提交、不可逆操作谨慎」。要换成自己的，把蒸馏产物写进 `~/.dsh/finish-line.persona.md` 覆盖，代码不用动。

## 两种执行器

| | `subagent`（默认） | `session` |
| --- | --- | --- |
| 形态 | 进程内 spawn，空对话，一句话 | 两个全新顶层会话，侧栏可见，一句话 |
| 模型 | 继承父会话模型 | 继承父会话 preset 与模型 |
| 可见性 | 父会话的「子代理」目录，侧栏不列 | 侧栏独立会话，可随时接管 |
| 拿不定主意 | 检测到「定不了」→ 人格决定后发回同一子代理 | `ask_user_question` → 人格代答 |
| 能否提问 | 不能（宿主 `DELEGATED_CALLER` 拒绝） | 能 |

省 token 用 `subagent`；要随时盯着、随时接手用 `session`。

## 日志与诊断

- `~/.dsh/logs/finish-line.log`：每步启动、`stopReason`、结果摘要、人格何时出场、拍板内容。触发判定也逐条记：非 Git 目录、工作区干净、还有排队输入，各写一行原因。
- `~/.dsh/finish-line.state.json`：按根会话记链，保留 7 天；设置了 `DSH_PROFILE_DIR` 时落在 profile 目录。

一次没触发，按日志最后一行定位：

| 日志里出现 | 含义 |
| --- | --- |
| 「不在 Git 仓库」 | 会话 cwd 不是 Git 仓库。 |
| 「工作区干净」 | 没有改动，按设计不触发。 |
| 「还有排队输入」 | 多敲的消息还没跑完，再等。 |
| 「启动收尾链」后没有「子代理已启动」 | 子代理后端没起来，看下一行错误。 |
| 「收尾第 N 步结束 stopReason=…」 | 该步结束，摘要里有它做了什么。 |

## 架构

```
index.js              插件全部逻辑：触发判定、链状态机、子代理 spawn、人格拍板、代答
cordis.patch.yml      bundle patch：插入插件行并给默认配置
locale/zh.json        插件市场里的中文名与一句话描述
locale/en.json        英文名与描述
icon.svg              插件图标
test/logic.test.mjs   纯逻辑测试（9 条）
```

只用 `ctx` 注入的宿主服务（`sessions` / `agents` / `sessionController` / `llm` / `subagents`）与 Node 内置模块；没有构建步骤；状态与日志都落在 `~/.dsh` 下。

## 测试

```sh
npm test        # node --test，9 条
```

覆盖配置默认值与非法值钳制、每步首条提示与配置原文逐字一致、`stageTitle` 的 80 字节上限、「定不了」信号识别、提问答案校验（单选 / 多选 / 自定义 / 无选项）、模型输出解析容错。

## 边界

- 子代理侧栏不可见。要接管就改 `executor: session`，或去父会话的子代理目录。
- 「定不了」靠信号词。误判只会多一次人格调用，不会重复干活。
- 未跟踪的大目录也算改动。`git status` 会把它算作「有改动」，先提交或清理。
- `session` 模式不代答计划审批。`plan-review` 意图的提问不会被替答，宁可挂住等真人。
- 必须重启 DSH 才生效。Host 半是进程内模块，只在启动时加载。
- 依赖三个接缝：`ctx.sessions` / `ctx.subagents` / `ctx.llm`；上游改这些接缝就得跟着改。

## 许可证

[MIT](LICENSE)
