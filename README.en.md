# dsh-finish-line

> Runs two serial wrap-up steps after a task session ends and its queued input drains: componentization cleanup, then critical commit.

[English](README.en.md) · [简体中文](README.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-9-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

A DeepSeek Harness (DSH) plugin. A model often stops halfway after writing a feature: shared functions scattered around, changes uncommitted, the diff unreviewed. Wrap-up is not within the goal of a single task; this plugin moves it after the turn ends and runs it separately.

## Trigger conditions

All five conditions must hold at once:

- **The work must actually be done**: the most recent `turn/end` reason must be `completed`. Quota-cut short (`error`), user interruption (`aborted`), or anything else never triggers — unfinished work does not enter the wrap-up.
- The session directory is a Git repository with changes.
- This session made at least one tool call. Pure Q&A does not trigger.
- Silence for `quietMs` after `turn/end` (default 20 seconds).
- The session's queued input is empty.

A previous chain on the same session that has already ended (`done` / `failed`) does not block a new round: it is cleared and the session is re-evaluated. Only a chain currently running is not re-triggered.

## How it works

```
turn/end(reason=completed) ──▶ quiet 20s ──▶ queue drained
                                            │
                                            ▼
                              check: Git repo && changes && tool called && work done
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
- Each step is one verbatim sentence, configured in `stages`. Subagents start from an empty conversation and receive **only that sentence, with no extra prompt**; they read `git diff` themselves and work from the repository context they find.
- No `agentOptions` is passed. Subagents inherit the parent session's provider / model / reasoning tier and are not downgraded to profile defaults.
- A chain runs once. Chain state is written to disk and restored from the state file after a DSH restart; the chain is not reopened.
- A turn does not end while the AI is asking a question in the task session, so the chain does not start. It does not answer on the session's behalf.

## Quick start

```sh
# 1. Clone into ~/.dsh/plugins/dsh-finish-line
git clone https://github.com/gpboyer2/dsh-finish-line.git ~/.dsh/plugins/dsh-finish-line

# 2. Register with a profile (command-line managed profiles such as web / main)
dsh plugin --profile <your-profile> add link:$HOME/.dsh/plugins/dsh-finish-line

# 3. Fully restart DSH. Host plugins load only at startup.
```

The `desktop` profile is owned by DeepSeek Harness.app, and command-line changes to it are rejected. For the desktop build, do it manually in three steps: create a same-named symlink under `~/.dsh/profiles/desktop/node_modules/`, add `"dsh-finish-line": "link:/absolute/path"` to `dependencies` in `package.json`, append `"dsh-finish-line"` to `dsh.profile.bundles`, then restart. Installing from the in-app Plugins page has the same effect.

The bundled `cordis.patch.yml` inserts the plugin line and sets the executor to `subagent`; no manual edit of the profile's patch file is needed.

To verify: in a Git repository with changes, have the AI run a small task that makes a tool call. Wait 20 seconds, then check `~/.dsh/logs/finish-line.log` for `启动收尾链` and the `子代理已启动` / `结束` lines of both steps.

On a first install, run with `dryRun: true`: logs only, no code changes. Turn it off once the trigger timing is confirmed.

## Core features

| Capability | Description |
| --- | --- |
| Auto trigger | Acts only when all four trigger conditions hold; no fuzzy matching. |
| Two serial steps | The next step starts only after the previous step's subagent ends; order is changed in `stages`. |
| Empty-conversation subagents | No inherited chat history or injected context; only the step sentence, nothing more. |
| Model inheritance | `agentOptions: null`; keeps the parent session's model and reasoning tier. |
| Two executors | `subagent` (default, not listed in the sidebar) or `session` (two new sessions, visible in the sidebar). |
| Persona is mandatory | When a subagent reports "can't decide / needs a decision", the distilled persona **always** decides and the decision is sent back to the same subagent; in `session` mode the persona **always** answers stage-session questions. **No switch — this is business logic, not an option.** |
| Resume | Chain state on disk, kept 7 days, at most 300 entries. |
| Visible answering | When the persona answers, the question, all options, and the persona's choice are appended to the stage session as a message you can see; a JSONL ledger is written as well. |
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
| `subagent.decideKeywords` | See source | Which reports count as "can't decide". A hit **always** triggers the persona; no switch exists. |
| `subagent.decideMaxWaitMs` | `600000` | Upper bound for waiting on that turn after the decision is sent back. If the decision fails, the chain is marked `failed`, the stuck report is logged verbatim; no silent skip. |
| `persona.file` | In-repo `persona/persona.md` | Distilled persona artifact shipped with this repository. Missing or empty = broken install, hard error; **no built-in fake persona fallback**. |
| `persona.maxContextBytes` / `maxOutputTokens` | `24576` / `700` | Session digest cap / per-call output cap for `session`-mode answering. |
| `persona.timeoutMs` / `retries` | `90000` / `1` | Timeout and retries for persona calls. |
| `logFile` | `~/.dsh/logs/finish-line.log` | Log location. |
| `decisionsFile` | `~/.dsh/finish-line.decisions.jsonl` | Decision ledger: one JSONL row per persona answer / decision. |

**Four non-negotiable rules for the persona (fixed by the user, 2026-11-25):**

1. When subagent A (refactor) or B (critical commit) needs a user decision, the distilled persona **must** decide, and the decision is sent back to the same subagent. Triggered by **signal detection** on the report; no extra prompt is given to subagents, and no switch exists.
2. The persona is **not bound to any machine-specific offline model**. Its inference route follows the host's current `agentDefaultModel` selection (the default model chosen in the GUI); changing environments changes the route automatically.
3. The distilled artifact `persona/persona.md` **lives in this repository** — installed with the plugin, never a stray file under `~/.dsh`, and there is no "use a built-in placeholder until distilled" path.
4. Decision/answering failures are never faked as success: in `subagent` mode the chain stops and logs the stuck report; in `session` mode it hands back to a human.

The persona file is a **decision-criteria library**, not a character biography — model the user's pushback as intent + satisfaction criteria + trigger condition, each backed by corpus evidence. To re-distill, just edit `persona/persona.md`; no code change needed.

## Two executors

| | `subagent` (default) | `session` |
| --- | --- | --- |
| Form | In-process spawn, empty conversation, step sentence only | Two new top-level sessions, visible in the sidebar, one sentence |
| Model | Inherits the parent session's model | Inherits the parent session's preset and model |
| Visibility | Parent session's subagents directory; not listed in the sidebar | Standalone session in the sidebar; can be taken over at any time |
| Can't decide | **Mandatory**: detects "can't decide" → persona decides → decision sent back to the same subagent | **Mandatory**: `ask_user_question` → persona answers |
| Can it ask questions | No (host `DELEGATED_CALLER` refuses); "can't decide" in the report is detected | Yes, intercepted and answered by the persona |

Use `subagent` to save tokens; use `session` to watch and take over at any time. The persona is mandatory in both executors; only the form differs.

## Logs and diagnostics

- `~/.dsh/logs/finish-line.log`: each step's start, `stopReason`, result summary, when the persona appeared, and the decision text. Trigger checks are also logged line by line: non-Git directory, clean working tree, pending queued input, and unfinished work each get one line with the reason. After an answer, a readable detail line (question → choice) is logged.
- When the persona answers, the question, all options, and the persona's choice are appended to the stage session as a "【人格代答】…" message **visible in the conversation** (`session` executor, listed in the sidebar). No need to guess what it chose.
- `~/.dsh/finish-line.decisions.jsonl`: the decision ledger, one row per entry. `kind=answer` records `session`-mode answering (question, all options, persona answer); `kind=decide` records `subagent`-mode decisions (the subagent's stuck report, the persona's decision). Review it directly or filter with `jq`.
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
index.js                All plugin logic: trigger checks, chain state machine, subagent spawn, persona decisions, answering
persona/persona.md      Distilled persona artifact (criteria library), shipped with the repository
cordis.patch.yml        bundle patch: inserts the plugin line and supplies default config
locale/zh.json          Chinese name and one-line description for the plugin market
locale/en.json          English name and description
icon.svg                Plugin icon
test/logic.test.mjs     Pure-logic tests (15)
```

Uses only host services injected via `ctx` (`sessions` / `agents` / `sessionController` / `llm` / `subagents` / `agentDefaultModel`) and Node built-in modules; no build step; state and logs both live under `~/.dsh`.

## Tests

```sh
npm test        # node --test, 15 tests
```

Coverage: config defaults and clamping, persona has no switches (`enabled` / `provider` / `model` / `decideOnStuck` are all absent), persona artifact path is inside the repo, persona intervention via signal detection, detection of "can't decide" signals, validation of question answers (single choice / multiple choice / custom / no options), tolerant parsing of model output.

One of them is a **hard constraint**: `buildStagePrompt` output must equal the stage sentence verbatim, and the source must not contain `buildSubagentPrompt` / `subagentRules` / `NEED-DECISION`; both first-prompt sites must call `buildStagePrompt(stage)` directly. Anyone trying to add extra prompt text for subagents makes `npm test` fail — a regression guard for "subagents receive only the sentence".

## Limits

- Subagents are not listed in the sidebar. To take over, set `executor: session` or open the parent session's subagents directory.
- "Can't decide" relies on the protocol + signal phrases. A false positive costs one extra persona call and does not redo the work; a failed decision never passes silently — the chain stops and logs the stuck report.
- Persona inference uses the host's GUI-selected default model (`agentDefaultModel.currentSelection()`); no machine binding. No default model configured → failed decision logged, chain stops.
- A large untracked directory also counts as a change. `git status` reports it as "has changes"; commit or clean it first.
- `session` mode does not answer plan approvals. Questions with `plan-review` intent are not answered; the chain would rather hang and wait for a human.
- A DSH restart is required. The host half is an in-process module and loads only at startup.
- Depends on host seams: `ctx.sessions` / `ctx.subagents` / `ctx.llm` / `ctx.agentDefaultModel`. If upstream changes these seams, this plugin has to follow.

## License

[MIT](LICENSE)
