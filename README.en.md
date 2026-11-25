# dsh-finish-line

> **The work is done; the wrap-up isn't.** —— Once the task session and its queued input are both empty, it runs two wrap-up steps in series: componentization cleanup, then critical commit.

[English](README.en.md) · [简体中文](README.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-9-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin. It watches for the end of a session turn. After you stop talking and the queue has drained, it appends two wrap-up steps on its own: first collect the shared functions in `git diff` into utils / shared modules, then call `cc-git-commit` to review the diff in batches, commit, and push.

## What problem it solves

The model finishes the feature and often just stops there: duplicated functions scattered around, changes not committed, the diff never reviewed. This is not because the model can't do it. "Wrap-up" is simply not part of the goal of a single task.

- Every time, you have to add a manual line: "tidy up the shared functions", "commit and push". Install it. It hooks in automatically.
- You want the wrap-up done by a **clean subagent**: one sentence in, it reads the diff itself, and it does not inherit the main session's pile of context. Install it.
- You want to see what it does first, without real code changes. Install it, set `dryRun: true`, logs only.
- Your tasks are pure Q&A and never touch files. No need to install. No tool call, no trigger.
- The directory is not a Git repository. No need to install.

There are only two criteria: the session's directory is a Git repository with changes, and this session made at least one tool call. Pure Q&A, a clean working tree, and non-Git directories never trigger it.

## How it works

```
turn/end  ──▶ quiet 20s ──▶ session inbox drained ──▶ check: Git repo && changes && tool call
                                                        │
                                                        ▼
                                          subagent A: step ② componentization cleanup
                                                        │ await result
                                                        ▼
                                          subagent B: step ③ critical commit
                                                        │
                                                        ▼
                                                  chain done
```

- **When it counts as "everything is said"**: after `turn/end`, stay quiet for `quietMs` (default 20 seconds), and the session's queued input is empty. The extra messages you typed run first; they never cut in ahead of the wrap-up.
- **No preloaded context**: both subagents start from an empty conversation. The first prompt is only that step's one sentence. They read `git diff` themselves and work with the repo context they find.
- **No model downgrade**: no `agentOptions` is passed; the subagent inherits the parent session's provider / model / reasoning tier. If the parent session has the full model, so does the subagent.
- **One chain runs once**: chains are tracked per root session and restored from `finish-line.state.json` after a restart. The same chain is never reopened.
- **The task session is left alone**: the turn does not end while the AI is asking questions, so the chain does not start. It never answers questions for you.

## Quick start

```sh
# 1. Clone into ~/.dsh/plugins/dsh-finish-line
git clone https://github.com/gpboyer2/dsh-finish-line.git ~/.dsh/plugins/dsh-finish-line

# 2. Register with the profile (a CLI-managed profile, such as web / main)
dsh plugin --profile <your-profile> add link:$HOME/.dsh/plugins/dsh-finish-line

# 3. Fully restart DSH —— host plugins load only at startup
```

> The `desktop` profile is owned exclusively by DeepSeek Harness.app; `dsh plugin --profile desktop …` from the CLI is rejected. For the desktop build, do it manually in three steps: create a symlink under `~/.dsh/profiles/desktop/node_modules/`, add `"dsh-finish-line": "link:/absolute/path"` to `package.json`'s `dependencies`, append `"dsh-finish-line"` to `dsh.profile.bundles`, then restart. Installing from the in-app "Plugins" page also works.

The bundled `cordis.patch.yml` inserts the plugin line and sets the executor to `subagent`. No need to hand-edit the profile's patch file.

**Verification**: in a Git repo with changes, have the AI do a small task that makes a tool call. Wait 20 seconds, then check `~/.dsh/logs/finish-line.log` for `启动收尾链` and the `子代理已启动` / `结束` lines of both steps.

> On a first install, run once with `dryRun: true`: logs only, no code changes. Confirm the trigger timing matches your expectations, then turn it off.

## Core features

| Capability | Description |
| --- | --- |
| **Auto trigger** | Turn ended + quiet window + queue empty + Git has changes + this session called a tool. All five must hold at once before it acts. |
| **Two serial steps** | ② componentization cleanup → ③ critical commit. The next step starts only after the previous step's subagent has ended. One sentence per step. |
| **Empty-conversation subagents** | No inherited chat history, no preset persona, no injected context. Tokens are spent on the work only. |
| **Full-model inheritance** | `agentOptions: null`; the subagent keeps the parent session's model and reasoning tier, not pulled down by profile defaults. |
| **Two executors** | `subagent` (default: fewer tokens, not listed in the sidebar) or `session` (two new sessions, visible in the sidebar, take over whenever you want). |
| **Persona on demand** | Only when the subagent itself reports "can't decide / needs a decision" does it call the persona model once to make the call. Zero cost otherwise. |
| **Resume after restart** | Chain state is written to disk, kept 7 days, at most 300 entries. A DSH restart does not reopen the same chain. |
| **dry-run** | Writes the decision and logs only; no subagent is really started, no code is changed. |
| **Zero dependencies** | Only the host services DSH injects and Node built-in modules. `link` install is the most reliable. |

## Configuration

Override the plugin line's `config:` in `~/.dsh/profiles/desktop/cordis.patch.yml`:

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

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `executor` | `subagent` | `subagent`: in-process spawn, empty conversation, not listed in the sidebar; `session`: two brand-new top-level sessions, visible in the sidebar. |
| `dryRun` | `false` | Logs only, no real run. |
| `quietMs` | `20000` | How long the silence after `turn/end` must last to count as "everything is said". |
| `requireToolCall` | `true` | Trigger requires at least one tool call in this session; pure Q&A does not trigger. |
| `maxChainAgeMs` | `21600000` | A chain lives at most 6 hours; after that it is not resumed. |
| `gitTimeoutMs` | `8000` | Per-call timeout for `git status` / `git diff`. |
| `stages` | Two verbatim sentences | `[{ id, titlePrefix, prompt }]`, one sentence per step; default titles `收尾② 组件化整理` / `收尾③ 批判提交`. Change step order and wording here. |
| `subagent.provider` | `spawn` | In-process subagent backend name. |
| `subagent.agentOptions` | `null` | `null` = not passed; inherit the parent session's full model. |
| `subagent.decideOnStuck` | `true` | Call the persona only when stuck. |
| `subagent.decideKeywords` | See source | Which phrases count as "can't decide". |
| `subagent.decideMaxWaitMs` | `600000` | Upper bound for waiting on its turn after the decision is sent back. |
| `persona.enabled` | `true` | Master switch for persona answering / deciding. |
| `persona.provider` / `model` | `magpie` / `local-31-99/qwen3.8-27b` | Model route used for answering. |
| `persona.file` | `~/.dsh/finish-line.persona.md` | Persona file; the built-in one is used when it does not exist. |
| `logFile` | `~/.dsh/logs/finish-line.log` | Log location. |

The built-in persona is: direct, minimal change, no fake compatibility, batched commits, careful with irreversible operations. To use your own, write the distilled result into `~/.dsh/finish-line.persona.md` to override it. No code change.

## Choosing between the two executors

| | `subagent` (default) | `session` |
| --- | --- | --- |
| Form | In-process spawned subagent, empty conversation, one sentence | Two brand-new top-level sessions, visible in the sidebar, one sentence |
| Model | Inherits the parent session's full model | Inherits the parent session's preset and model |
| What you can see | Listed in the parent session's subagent directory, not in the sidebar | Standalone session in the sidebar; click in and take over any time |
| Can't decide | Detects "can't decide" → persona decides, then sends back to the same subagent | `ask_user_question` → persona answers instead |
| Can it ask questions | No (host `DELEGATED_CALLER` refuses) | Yes |

Use `subagent` to save tokens; use `session` to watch and take over at any time.

## Logs and diagnostics

- `~/.dsh/logs/finish-line.log`: each step's start, `stopReason`, result summary, when the persona stepped in, and the decision text. Trigger decisions are also logged line by line: non-Git directory, clean working tree, and pending queued input each get a line with the reason.
- `~/.dsh/finish-line.state.json`: chains tracked per root session, kept 7 days; placed in the profile directory when `DSH_PROFILE_DIR` is set.

If it did not trigger, locate it from the last log line:

| Appears in the log | Meaning |
| --- | --- |
| `不在 Git 仓库` | The session cwd is not a Git repository |
| `工作区干净` | No changes; does not trigger by design |
| `还有排队输入` | The extra messages you typed have not finished; wait |
| `启动收尾链` with no `子代理已启动` after it | The subagent backend did not come up; read the error on the next line |
| `收尾第 N 步结束 stopReason=…` | That step ended; the summary shows what it did |

## Architecture

```
index.js              All plugin logic: trigger checks, chain state machine, subagent spawn, persona decisions, answering
cordis.patch.yml      bundle patch: inserts the plugin line and supplies default config
locale/zh.json        Chinese name and one-line description for the plugin market
locale/en.json        English name and description
icon.svg              Plugin icon
test/logic.test.mjs   Pure-logic tests (9)
```

Design constraints: only the host services injected via `ctx` (`sessions` / `agents` / `sessionController` / `llm` / `subagents`) and Node built-in modules; no build step; state and logs both live under `~/.dsh`.

## Development and testing

```sh
npm test        # node --test, 9 tests
```

Coverage: config defaults and clamping of invalid values, each step's first prompt matching the configured sentence verbatim, the 80-byte cap on `stageTitle`, detection of "can't decide" signals, validation of question answers (single choice / multi choice / custom / no options), and tolerance when parsing model output.

## Known limits

- **Subagents are not visible in the sidebar**: to take over, set `executor: session`, or go to the parent session's subagent directory.
- **"Can't decide" relies on signal phrases**: a misjudgement costs one extra persona call; it does not redo the work.
- **A large untracked directory also counts as a change**: `git status` counts it as "has changes"; commit or clean up first in that case.
- **`session` mode does not answer plan approvals**: questions with `plan-review` intent are not answered for you; it would rather hang and wait for a human.
- **A DSH restart is required**: the host half is an in-process module and loads only at startup.
- **Depends on three seams**: `ctx.sessions` / `ctx.subagents` / `ctx.llm`; if upstream changes these seams, this plugin has to follow.

## License

[MIT](LICENSE)
