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

以下五条同时满足才启动：

- **活必须真干完**：该会话最近一次 `turn/end` 的结束原因是 `completed`。被额度卡断（`error`）、用户主动中断（`aborted`）一律不触发——没干完就不进收尾。
- 会话所在目录是 Git 仓库，且有改动。
- 本会话至少发生过一次工具调用。纯问答不触发。
- `turn/end` 之后静默 `quietMs`（默认 20 秒）。
- 该会话的排队输入已清空。

同一会话上一条已结束的旧链（`done` / `failed`）不挡新一轮：会被清掉，按本轮重新判定。只有正在运行的链不重复触发。

## 工作方式

```
turn/end(reason=completed) ──▶ 静默 20s ──▶ 排队输入清空
                                            │
                                            ▼
                              判定：Git 仓库 && 有改动 && 调过工具 && 活干完
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
- 两步各是一句原话，在 `stages` 里配置。子代理从空对话开始，只收到这一句 + NEED-DECISION 协议，自己看 `git diff`，结合仓库上下文干活。
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
| 空对话子代理 | 不继承聊天记录、不预置上下文，只发步骤原话 + NEED-DECISION 协议。 |
| 模型继承 | `agentOptions: null`，沿用父会话的模型与推理档。 |
| 两种执行器 | `subagent`（默认，侧栏不列）或 `session`（两个新会话，侧栏可见）。 |
| 人格必然介入 | 子代理汇报「定不了 / 需要拍板」→ 蒸馏人格必然拍板，决定发回同一子代理；session 模式的收尾提问必然由人格代答。**没有开关，是必然业务。** |
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
| `subagent.decideKeywords` | 见源码 | 哪些汇报算「定不了」（含 `NEED-DECISION`）。命中则人格**必然**拍板，没有开关。 |
| `subagent.decideMaxWaitMs` | `600000` | 拍板发回后等它这一轮的上限。拍板失败 → 链标 `failed`，卡点原文写进日志，绝不静默跳过。 |
| `persona.file` | 仓库内 `persona/persona.md` | 蒸馏人格产物，随本仓库分发。读不到/为空 = 安装损坏，报错；**没有内置假人格兜底**。 |
| `persona.maxContextBytes` / `maxOutputTokens` | `24576` / `700` | session 模式代答的会话摘要上限 / 单次输出上限。 |
| `persona.timeoutMs` / `retries` | `90000` / `1` | 人格调用的超时与重试。 |
| `persona.subagentRules` | 见源码 | 注入给子代理的 NEED-DECISION 协议。 |
| `logFile` | `~/.dsh/logs/finish-line.log` | 日志位置。 |

**人格的四条铁律（2026-11-25 用户定死，不可配置）：**

1. 子代理 A（组件化整理）或 B（批判提交）遇到需要用户拍板的事，**必然**把蒸馏人格请出来判定，决定发回同一个子代理继续。靠 `NEED-DECISION` 协议触发，不靠开关。
2. 人格**不绑定任何特定机器上的离线模型**。推理路由跟随宿主 `agentDefaultModel` 的当前选择（GUI 里选的默认模型），换环境自动换。
3. 蒸馏人格产物 `persona/persona.md` **在本仓库里**，装上就有；不是 `~/.dsh` 下的散落文件，也没有「还没蒸馏就先用内置兜底」这一说。
4. 拍板/代答失败不作假成功：subagent 模式链停下并把卡点原文写进日志，session 模式交回真人。

人格文件是「拍板判据库」而不是人物传记——按用户的真实 pushback 建模为「意图 + 满足判据 + 触发条件」，每条判据附语料证据。要重蒸馏，改 `persona/persona.md` 即可，代码不用动。

## 两种执行器

| | `subagent`（默认） | `session` |
| --- | --- | --- |
| 形态 | 进程内 spawn，空对话，步骤原话 + NEED-DECISION 协议 | 两个全新顶层会话，侧栏可见，一句原话 |
| 模型 | 继承父会话模型 | 继承父会话 preset 与模型 |
| 可见性 | 父会话的「子代理」目录，侧栏不列 | 侧栏独立会话，可随时接管 |
| 拿不定主意 | **必然**：检测到「定不了」→ 人格拍板 → 发回同一子代理 | **必然**：`ask_user_question` → 人格代答 |
| 能否提问 | 不能（宿主 `DELEGATED_CALLER` 拒绝），靠协议喊 NEED-DECISION | 能，由人格拦下代答 |

省 token 用 `subagent`；要随时盯着、随时接手用 `session`。两种执行器的人格介入都是必然业务，只是形态不同。

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
index.js                  插件全部逻辑：触发判定、链状态机、子代理 spawn、人格拍板、代答
persona/persona.md        蒸馏人格产物（判据库），随仓库分发
cordis.patch.yml          bundle patch：插入插件行并给默认配置
locale/zh.json            插件市场里的中文名与一句话描述
locale/en.json            英文名与描述
icon.svg                  插件图标
test/logic.test.mjs       纯逻辑测试（13 条）
```

只用 `ctx` 注入的宿主服务（`sessions` / `agents` / `sessionController` / `llm` / `subagents` / `agentDefaultModel`）与 Node 内置模块；没有构建步骤；状态与日志都落在 `~/.dsh` 下。

## 测试

```sh
npm test        # node --test，13 条
```

覆盖配置默认值与非法值钳制、人格无开关（enabled/provider/model/decideOnStuck 均不存在）、人格产物路径在仓库内、每步首条提示与配置原文逐字一致、NEED-DECISION 协议注入与信号词咬合、「定不了」信号识别、提问答案校验（单选 / 多选 / 自定义 / 无选项）、模型输出解析容错。

## 边界

- 子代理侧栏不可见。要接管就改 `executor: session`，或去父会话的子代理目录。
- 「定不了」靠协议 + 信号词；误判只会多一次人格调用，不会重复干活；漏判不会静默放过——拍板失败链会停下，卡点留在日志。
- 人格拍板用的模型是宿主 GUI 里选的默认模型（`agentDefaultModel.currentSelection()`），不绑定任何机器。没配过默认模型 → 拍板失败并记日志，链停下。
- 未跟踪的大目录也算改动。`git status` 会把它算作「有改动」，先提交或清理。
- `session` 模式不代答计划审批。`plan-review` 意图的提问不会被替答，宁可挂住等真人。
- 必须重启 DSH 才生效。Host 半是进程内模块，只在启动时加载。
- 依赖宿主接缝：`ctx.sessions` / `ctx.subagents` / `ctx.llm` / `ctx.agentDefaultModel`；上游改这些接缝就得跟着改。

## 许可证

[MIT](LICENSE)
