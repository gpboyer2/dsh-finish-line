# dsh-finish-line

> After a task session ends and its queued input drains, two wrap-up steps run in series: move shared functions into shared modules, then review the diff in batches, commit, and push.

[English](README.en.md) · [简体中文](README.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-9-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

A DeepSeek Harness (DSH) plugin. A model often stops halfway after writing a feature: shared functions scattered around, changes uncommitted, the diff unreviewed. Wrap-up is not within the goal of a single task; this plugin moves it after the turn ends and runs it separately.

## Trigger conditions

All four conditions must hold at once:

- The session directory is a Git repository with changes.
- This session made at least one tool call. Pure Q&A does not trigger.
- Silence for `quietMs` after `turn/end` (default 20 seconds).
- The session's queued input is empty.

## How it works

```
turn/end ──▶ quiet 20s ──▶ queue drained ──▶ check: Git repo && changes && tool called
                                                    │
                                                    ▼
                                  subagent A: componentization cleanup
                                                    │ await result
                                                    ▼
                                       subagent B: critical commit
                                                    │
                                                    ▼
                                               chain done
```

- After the checks pass, subagent A starts and runs "componentization cleanup": it moves shared functions from `git diff` into utils / shared modules.
- When A ends, subagent B starts and runs "critical commit": it calls `cc-git-commit` to review the diff in batches, commit, and push.
- Each step is one verbatim sentence, configured in `stages`. Subagents start from an empty conversation, receive only that sentence, read `git diff` themselves, and work from the repository context they find.
- No `agentOptions` is passed. Subagents inherit the parent session's provider / model / reasoning tier and are not downgraded to profile defaults.
- A chain runs once. Chain state is written to disk and restored from the state file after a DSH restart; the chain is not reopened.
- A turn does not end while the AI is asking a question in the task session, so the chain does not start. It does not answer for the user.

## Quick start

```sh
# 1. Clone into ~/.dsh/plugins/dsh-finish-line
git clone https://github.com/gpboyer2/dsh-finish-line.git ~/.dsh/plugins/dsh-finish-line

# 2. Register with a profile (command-line managed profiles such as web / main)
dsh plugin --profile <your-profile> add link:$HOME/.dsh/plugins/dsh-finish-line

# 3. Fully restart DSH. Host plugins load only at startup.
```

The `desktop` profile is owned by DeepSeek Harness.app; the command line rejects changes to it. For the desktop build, register it manually in three steps: create a same-named symlink under `~/.dsh/profiles/desktop/node_modules/`, add `"dsh-finish-line": "link:/absolute/path"` to `dependencies` in `package.json`, append `"dsh-finish-line"` to `dsh.profile.bundles`, then restart. Installing from the in-app Plugins page has the same effect.

The bundled `cordis.patch.yml` inserts the plugin line and sets the executor to `subagent`; no manual edit of the profile's patch file is needed.

To verify: in a Git repository with changes, have the AI run a small task that makes a tool call. Wait 20 seconds, then check `~/.dsh/logs/finish-line.log` for `启动收尾链` and the `子代理已启动` / `结束` lines of both steps.

A first install should start with `dryRun: true`: logs only, no code changes. Turn it off once the trigger timing is confirmed.

## Core features

| Capability | Description |
| --- | --- |
| Auto trigger | Acts only when all four trigger conditions hold; no fuzzy matching. |
| Two serial steps | The next step starts only after the previous step's subagent ends; order is changed in `stages`. |
| Empty-conversation subagents | No inherited chat history, no preset persona, no injected context. |
| Model inheritance | `agentOptions: null`; keeps the parent session's model and reasoning tier. |
| Two executors | `subagent` (default, not listed in the sidebar) or `session` (two new sessions, visible in the sidebar). |
| Persona on demand | Calls the persona model once only when a subagent reports "cannot decide / needs a decision"; no call otherwise. |
| Resume | Chain state on disk, kept 7 days, at most 300 entries. |
| dry-run | Writes the decision and logs only; starts no subagent, changes no code. |
| Zero dependencies | Only host services injected by DSH and Node built-in modules. |

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
| `executor` | `subagent` | `subagent`: in-process spawn, empty conversation, not listed in the sidebar; `session`: two new top-level sessions, visible in the sidebar. |
| `dryRun` | `false` | Logs only, no real run. |
| `quietMs` | `20000` | Silence window after `turn/end`. |
| `requireToolCall` | `true` | Triggers only if the session made at least one tool call. |
| `maxChainAgeMs` | `21600000` | A chain lives at most 6 hours; after that it is not resumed. |
| `gitTimeoutMs` | `8000` | Per-call timeout for `git status` / `git diff`. |
| `stages` | Two verbatim sentences | `[{ id, titlePrefix, prompt }]`, one sentence per step; default titles `收尾② 组件化整理` / `收尾③ 批判提交`. Order and wording are changed here. |
| `subagent.provider` | `spawn` | In-process subagent backend name. |
| `subagent.agentOptions` | `null` | `null` = not passed; inherits the parent session's model. |
| `subagent.decideOnStuck` | `true` | Calls the persona only when stuck. |
| `subagent.decideKeywords` | See source | Which phrases count as "cannot decide". |
| `subagent.decideMaxWaitMs` | `600000` | Upper bound for waiting on that turn after the decision is sent back. |
| `persona.enabled` | `true` | Master switch for persona answering / deciding. |
| `persona.provider` / `model` | `magpie` / `local-31-99/qwen3.8-27b` | Persona model route. The defaults point at the author's local setup; replace them in your environment. If the route does not exist, one "persona decision failed" line is logged and the chain continues. |
| `persona.file` | `~/.dsh/finish-line.persona.md` | Persona file; the built-in one is used when it does not exist. |
| `logFile` | `~/.dsh/logs/finish-line.log` | Log location. |

The default persona is a built-in set of rules: direct, minimal change, no fake compatibility, batched commits, cautious with irreversible operations. To make it closer to your own judgement, write rules to `~/.dsh/finish-line.persona.md` to override it. No code change.

## Two executors

| | `subagent` (default) | `session` |
| --- | --- | --- |
| Form | In-process spawn, empty conversation, one sentence | Two new top-level sessions, visible in the sidebar, one sentence |
| Model | Inherits the parent session's model | Inherits the parent session's preset and model |
| Visibility | Parent session's subagents directory; not listed in the sidebar | Standalone session in the sidebar; can be taken over at any time |
| Cannot decide | Detects "cannot decide" → persona decides, then sends back to the same subagent (no decision when `persona.enabled` is false) | `ask_user_question` → persona answers |
| Can it ask questions | No (host `DELEGATED_CALLER` refuses) | Yes |

Use `subagent` to save tokens; use `session` to watch and take over at any time.

## Logs and diagnostics

- `~/.dsh/logs/finish-line.log`: each step's start, `stopReason`, result summary, when the persona appeared, and the decision text. Trigger checks are also logged line by line: `不在 Git 仓库`, `工作区干净`, and `还有排队输入` each get one line with the reason.
- `~/.dsh/finish-line.state.json`: chains tracked per root session, kept 7 days; placed in the profile directory when `DSH_PROFILE_DIR` is set.

If it did not trigger, locate the cause from the last log line:

| Appears in the log | Meaning |
| --- | --- |
| `不在 Git 仓库` | The session cwd is not a Git repository. |
| `工作区干净` | No changes; does not trigger by design. |
| `还有排队输入` | Extra messages have not finished; wait longer. |
| `启动收尾链` with no `子代理已启动` after it | The subagent backend did not start; read the error on the next line. |
| `收尾第 N 步结束 stopReason=…` | That step ended; the summary shows what it did. |

## Architecture

```
index.js              All plugin logic: trigger checks, chain state machine, subagent spawn, persona decisions, answering
cordis.patch.yml      bundle patch: inserts the plugin line and supplies default config
locale/zh.json        Chinese name and one-line description for the plugin market
locale/en.json        English name and description
icon.svg              Plugin icon
test/logic.test.mjs   Pure-logic tests (9)
```

Uses only host services injected via `ctx` (`sessions` / `agents` / `sessionController` / `llm` / `subagents`) and Node built-in modules; no build step; state and logs both live under `~/.dsh`.

## Tests

```sh
npm test        # node --test, 9 tests
```

Coverage: config defaults and clamping of invalid values, each step's first prompt matching the configured sentence verbatim, the 80-byte cap on `stageTitle`, detection of "cannot decide" signals, validation of question answers (single choice / multiple choice / custom / no options), and tolerant parsing of model output.

## Limits

- Subagents are not listed in the sidebar. To take over, set `executor: session` or open the parent session's subagents directory.
- "Cannot decide" relies on signal phrases. A false positive costs one extra persona call and does not redo the work.
- A large untracked directory also counts as a change. `git status` reports it as "has changes"; commit or clean it first.
- `session` mode does not answer plan approvals. Questions with `plan-review` intent are not answered; the chain would rather hang and wait for a human.
- A DSH restart is required. The host half is an in-process module and loads only at startup.
- Depends on three seams: `ctx.sessions` / `ctx.subagents` / `ctx.llm`. If upstream changes these seams, this plugin has to follow.
- The persona model is not shipped with the repository. The default route points at the author's local setup; until it is replaced, the decision call fails, leaves one log line, and the chain continues.

## License

[MIT](LICENSE)
