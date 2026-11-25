# dsh-finish-line

> **活干完了，收尾还没干。** —— 任务会话、排队输入都清空之后，自动串行跑完「组件化整理」和「批判提交」两步。

[简体中文](README.md) · [English](README.en.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-9-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。它监听会话回合结束，在你把话说完、队列也跑完之后，自动接上两步收尾：先把 `git diff` 里的公共函数收进 utils / 公共模块，再调 `cc-git-commit` 分批审 diff、提交、推送。

## 它解决什么问题

模型把功能写完，常常就停在那里：重复函数散落在各处，改动没提交，diff 没人审。这不是模型不会，而是「收尾」本身不在一次任务的目标里。

- 你每次都得手动补一句「整理一下公共函数」「提交推送」。装。它自动接上。
- 你希望收尾由一个**干净的子代理**来做，只给一句话、自己看 diff，不继承主会话那一大堆上下文。装。
- 你想先看它怎么动，不想真改代码。装，开 `dryRun: true`，只写日志。
- 你的任务都是纯问答、从不改文件。不用装。没有工具调用就不会触发。
- 目录不是 Git 仓库。不用装。

判断标准只有两条：会话所在目录是 Git 仓库且有改动，且本会话至少发生过一次工具调用。纯问答、干净工作区、非 Git 目录都不会触发。

## 工作原理

```
turn/end  ──▶ 静默 20s ──▶ 会话 inbox 已清空 ──▶ 判定：Git 仓库 && 有改动 && 调过工具
                                                        │
                                                        ▼
                                          子代理 A：第 ② 句「组件化整理」
                                                        │ await result
                                                        ▼
                                          子代理 B：第 ③ 句「批判提交」
                                                        │
                                                        ▼
                                                    链完成
```

- **什么时候算「都说完了」**：`turn/end` 之后静默 `quietMs`（默认 20 秒），且该会话的排队输入已经清空。你多敲的几条会先跑完，不会和收尾插队。
- **上下文不预置**：两个子代理都以空对话开始，首条提示只有那一步的一句原话。它们自己看 `git diff`、自己结合仓库上下文干活。
- **模型不降级**：不传 `agentOptions`，子代理继承父会话的 provider / model / 推理档。父会话是满血模型，它就是满血。
- **一条链只跑一次**：按根会话记链，重启后从 `finish-line.state.json` 恢复，不会重开。
- **任务会话本身不干预**：AI 提问时回合不结束，链也不会启动；它不会替你去答问题。

## 快速开始

```sh
# 1. 克隆到 ~/.dsh/plugins/dsh-finish-line
git clone https://github.com/gpboyer2/dsh-finish-line.git ~/.dsh/plugins/dsh-finish-line

# 2. 注册到 profile（命令行管理的 profile，如 web / main）
dsh plugin --profile <你的profile> add link:$HOME/.dsh/plugins/dsh-finish-line

# 3. 完整重启 DSH —— Host 插件只在启动时加载
```

> `desktop` profile 由 DeepSeek Harness.app 独占，命令行 `dsh plugin --profile desktop …` 会被拒。桌面版手动三步：在 `~/.dsh/profiles/desktop/node_modules/` 下建同名软链、`package.json` 的 `dependencies` 加 `"dsh-finish-line": "link:/绝对路径"`、`dsh.profile.bundles` 末尾加 `"dsh-finish-line"`，再重启。在应用内「插件」页安装也一样。

包内的 `cordis.patch.yml` 会自动插入插件行，并把执行器设为 `subagent`。不用手改 profile 的 patch 文件。

**验证**：在一个有改动的 Git 仓库里让 AI 干一件带工具调用的小活，等 20 秒，看 `~/.dsh/logs/finish-line.log` 是否出现「启动收尾链」以及两步的「子代理已启动 / 结束」。

> 首次安装建议先 `dryRun: true` 跑一遍：只写日志、不动代码，确认触发时机符合预期再关掉。

## 核心功能

| 能力 | 说明 |
| --- | --- |
| **自动触发** | 回合结束 + 静默窗口 + 队列清空 + Git 有改动 + 本会话调过工具，五条同时满足才动手。 |
| **两步串行** | ② 组件化整理 → ③ 批判提交，前一步的子代理结束后才启下一步；每步一句话。 |
| **空对话子代理** | 不继承父会话聊天记录，不预置人格，不塞上下文；token 只花在活上。 |
| **满血继承** | `agentOptions: null`，子代理沿用父会话的模型与推理档，不被 profile 默认值拖低。 |
| **两种执行器** | `subagent`（默认，省 token、侧栏不列）或 `session`（两个新会话，侧栏可见，可随时接管）。 |
| **按需请人格** | 只有子代理自己汇报「定不了 / 需要拍板」时，才调一次人格模型替它拍一句；平时零开销。 |
| **断点恢复** | 链状态落盘，保留 7 天、最多 300 条；DSH 重启后不会重开同一条链。 |
| **dry-run** | 只写判定与日志，不真正启子代理、不改代码。 |
| **零依赖** | 只用 DSH 注入的宿主服务与 Node 内置模块，`link` 安装最稳。 |

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
| `quietMs` | `20000` | `turn/end` 之后静默多久算「都说完了」。 |
| `requireToolCall` | `true` | 本会话至少一次工具调用才触发；纯问答不触发。 |
| `maxChainAgeMs` | `21600000` | 一条链最长存活 6 小时，超时不再恢复。 |
| `gitTimeoutMs` | `8000` | `git status` / `git diff` 的单次超时。 |
| `stages` | 两句原话 | `[{ id, titlePrefix, prompt }]`，每一步只发一句。两步的顺序、文案都在这里改。 |
| `subagent.provider` | `spawn` | 进程内子代理后端名。 |
| `subagent.agentOptions` | `null` | `null` = 不传，继承父会话满血模型。 |
| `subagent.decideOnStuck` | `true` | 卡住时才请人格。 |
| `subagent.decideKeywords` | 见源码 | 哪些话算「定不了」。 |
| `subagent.decideMaxWaitMs` | `600000` | 拍板发回后等它这一轮的上限。 |
| `persona.enabled` | `true` | 人格代答 / 拍板总开关。 |
| `persona.provider` / `model` | `magpie` / `local-31-99/qwen3.8-27b` | 代答用的模型路由。 |
| `persona.file` | `~/.dsh/finish-line.persona.md` | 人格文件；不存在时用内置的一份。 |
| `logFile` | `~/.dsh/logs/finish-line.log` | 日志位置。 |

内置人格是「直接、最小改动、拒绝假兼容、分批提交、不可逆操作谨慎」。要换成你自己的，把蒸馏产物写进 `~/.dsh/finish-line.persona.md` 覆盖，代码不用动。

## 两种执行器怎么选

| | `subagent`（默认） | `session` |
| --- | --- | --- |
| 形态 | 进程内 spawn 子代理，空对话，一句话 | 两个全新顶层会话，侧栏可见，一句话 |
| 模型 | 继承父会话满血模型 | 继承父会话 preset 与模型 |
| 你能看到 | 父会话的「子代理」目录里，侧栏不列 | 侧栏独立会话，随时点进去接管 |
| 拿不定主意 | 检测到「定不了」→ 人格决定后发回同一子代理 | `ask_user_question` → 人格代答 |
| 能不能提问 | 不能（宿主 `DELEGATED_CALLER` 拒绝） | 能 |

省 token 走 `subagent`；想随时盯着、随时接手走 `session`。

## 日志与诊断

- `~/.dsh/logs/finish-line.log`：每步启动、`stopReason`、结果摘要、人格何时出场、拍板内容。触发判定也逐条记：非 Git 目录、工作区干净、还有排队输入，都会写一行原因。
- `~/.dsh/finish-line.state.json`：按根会话记链，保留 7 天；设置了 `DSH_PROFILE_DIR` 时落在 profile 目录。

一次没触发，按日志最后一行定位：

| 日志里出现 | 含义 |
| --- | --- |
| 「不在 Git 仓库」 | 会话 cwd 不是 Git 仓库 |
| 「工作区干净」 | 没有改动，按设计不触发 |
| 「还有排队输入」 | 你多敲的消息还没跑完，再等 |
| 「启动收尾链」之后没有「子代理已启动」 | 子代理后端没起来，看下一行的错误 |
| 「收尾第 N 步结束 stopReason=…」 | 该步结束，摘要里能看到它干了什么 |

## 架构

```
index.js              插件全部逻辑：触发判定、链状态机、子代理 spawn、人格拍板、代答
cordis.patch.yml      bundle patch：插入插件行并给默认配置
locale/zh.json        插件市场里的中文名与一句话描述
locale/en.json        英文名与描述
icon.svg              插件图标
test/logic.test.mjs   纯逻辑测试（9 条）
```

设计约束：只用 `ctx` 注入的宿主服务（`sessions` / `agents` / `sessionController` / `llm` / `subagents`）与 Node 内置模块；没有构建步骤；状态与日志都落在 `~/.dsh` 下。

## 开发与测试

```sh
npm test        # node --test，9 条
```

覆盖点：配置默认值与非法值钳制、每步首条提示与用户原文逐字一致、`stageTitle` 的 80 字节上限、「定不了」信号识别、提问答案的校验（单选/多选/自定义/无选项）、模型输出解析容错。

## 已知边界

- **子代理侧栏不可见**：要接管就改 `executor: session`，或去父会话的子代理目录。
- **「定不了」靠信号词**：误判只会多一次人格调用，不会重复干活。
- **未跟踪的大目录也算改动**：`git status` 会把它算作「有改动」；这种情况先提交或清理。
- **`session` 模式不代答计划审批**：`plan-review` 意图的提问不会被替答，宁可挂住等真人。
- **必须重启 DSH 才生效**：Host 半是进程内模块，只在启动时加载。
- **依赖三个接缝**：`ctx.sessions` / `ctx.subagents` / `ctx.llm`；上游改这些接缝就得跟着改。

## 许可证

[MIT](LICENSE)
