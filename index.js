/**
 * dsh-finish-line —— 任务会话结束后的「收尾流水线」
 *
 * 用户的一个任务（干活）结束后，本插件自动串行跑两个收尾步骤：
 *   ① 组件化整理（把公共函数收进 utils，按模块化举一反三）
 *   ② 批判式提交（调 cc-git-commit、分批推送、审 diff 找隐患/bug/遗漏）
 *
 * 两种执行器（config.executor）：
 *   - `subagent`（默认）：进程内 spawn 子代理。**不传 agentOptions → 继承父会话
 *     的 provider/model/推理档**（父会话是满血模型，子代理不再被 profile 里的
 *     27B 默认值拖低）；空对话开始 + 只发两句话，父上下文不会渗进来；子代理
 *     侧边栏隐藏，要接手在父会话的子代理面板里看。代价：子代理**不能**
 *     ask_user_question（宿主以 DELEGATED_CALLER 拒绝），所以遇到「该用户拍板」
 *     的事它会在汇报里说「定不了」，插件检测到信号就请蒸馏人格（本仓库
 *     persona/persona.md）替它拍板，决定发回同一个子代理继续。子代理只收
 *     步骤原话，不预置任何额外提示词。
 *   - `session`：开两个全新顶层会话（侧边栏可见），老路；这条路的人格介入
 *     形态是拦 user-questions/request 代答。
 *
 * 人格（用户 2026-11-25 定死，不可退让）：
 *   - 蒸馏产物与本插件同仓库（persona/persona.md），装上就在，不依赖任何
 *     机器上的外部产物；读不到就是安装损坏，报错，不用内置假人格兜底。
 *   - 人格介入是必然业务：子代理汇报「定不了」必调、session 模式的收尾提问
 *     必代答。没有 enabled / decideOnStuck 这类开关。
 *   - 人格模型的推理路由跟随宿主 `agentDefaultModel` 的当前选择（GUI 里选的
 *     默认模型）；不绑定、不提及任何特定机器上的离线模型。
 *   - 代答失败不作假成功：session 模式交回真人（next()）；subagent 模式链停下
 *     并标 failed，把子代理卡点原文写进日志，绝不静默继续下一步。
 *
 * 规则（用户 2026-11-25 明确要求）：
 *   - 触发：会话所在目录是 Git 仓库且有改动 → 必然触发；纯问答不触发。
 *   - 「等所有的话都说完了」：不靠静默计时，靠「排队」判定——所有顶层会话都
 *     不在跑 turn、也没有排队输入时，才算全部干完，才启动收尾。
 *   - 任务会话本身绝不干预：那里 AI 提问就挂着等人（阻塞式提问时 turn 不会
 *     结束，链也不会启动）。
 *   - plan-review（计划审批）不代答，宁可挂住；代答失败一律 next() 交回真人。
 *
 * 只用 ctx 注入的宿主服务与 Node 内置模块，link 安装最稳。
 *
 * @module dsh-finish-line
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** 插件 id，需与 cordis.patch.yml 的 id 一致。 */
export const name = 'dsh-finish-line'

/** 依赖的宿主服务（subagents 只在 subagent 执行器下需要）。 */
export const inject = ['sessions', 'agents', 'sessionController', 'llm', 'subagents']

/** 代答消息的 producer-owned source kind（会话格式 v4 要求）。 */
const SOURCE_KIND = `plugin:${name}`

/** 手动触发收尾的斜杠命令名（宿主要求匹配 /^[a-z][a-z0-9_-]*$/）。 */
export const FINISH_COMMAND = 'finish'

/** 手动触发收尾的 HTTP 路由，给会话按钮或外部脚本用。 */
export const TRIGGER_PATH = '/api/finish-line.trigger'

/** 统一 JSON 响应（路由用）。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const STATE_MAX_CHAINS = 300

/** 插件目录（人格产物随仓库分发，装上就在）。 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 默认配置。 */
export const DEFAULTS = {
  enabled: true,
  /** `subagent`（默认，省 token、满血、空对话）或 `session`（新会话，侧栏可见）。 */
  executor: 'subagent',
  /** 只写日志、不真跑（首次安装先观察用）。 */
  dryRun: false,
  /**
   * 静默期：本项目最后一次活动之后，整整这段时间没有任何动静（继续说话、
   * 新开会话、别的会话干活都算动静）才启动收尾。默认 20 分钟，避免用户
   * 灵光一闪回来接着干时和已在跑的收尾子代理撞车。
   */
  idleMs: 20 * 60 * 1000,
  /** 本次会话至少发生过一次工具调用才算「干过活」，纯问答不触发。 */
  requireToolCall: true,
  maxChainAgeMs: 6 * 60 * 60 * 1000,
  gitTimeoutMs: 8000,
  /** 收尾两步。 */
  stages: [
    {
      id: 'refactor',
      titlePrefix: '收尾② 组件化整理',
      prompt: 'git diff 将公共函数整理到 utils 相关模块中，要求在组件化、模块化的指导思路下举一反三，以此类推；',
    },
    {
      id: 'commit',
      titlePrefix: '收尾③ 批判提交',
      prompt: '调用技能 cc-git-commit 同步并推送代码，分批，注意 diff 的过程中批判下、看看有没有隐患、bug、遗漏；',
    },
  ],
  subagent: {
    /** 进程内 spawn 后端名。 */
    provider: 'spawn',
    /**
     * 子代理模型路由。null = 不传 agentOptions，继承父会话的 provider/model/
     * reasoningEffort（父会话是满血模型时，子代理也是）。
     */
    agentOptions: null,
    /** 子代理汇报里出现这些信号，必然把人格请出来拍板（非开关，无退出条件）。 */
    decideKeywords: [
      '无法继续',
      '无法确定',
      '不确定',
      '需要确认',
      '需要决定',
      '需要拍板',
      '请你决定',
      'waiting for confirmation',
    ],
    /** 注入人格后，等它这一轮结束的上限。 */
    decideMaxWaitMs: 600000,
  },
  persona: {
    /**
     * 蒸馏人格文件，随本仓库分发（不存在 = 安装损坏，直接报错，不用内置
     * 假人格兜底）。
     */
    file: path.join(PLUGIN_DIR, 'persona', 'persona.md'),
    maxContextBytes: 24576,
    maxOutputTokens: 700,
    timeoutMs: 90000,
    retries: 1,
  },
  logFile: path.join(os.homedir(), '.dsh', 'logs', 'finish-line.log'),
  /**
   * 决策台账：人格代答/拍板的完整记录（问题、全部选项、答案），JSONL 一行
   * 一条，供事后复盘。不写进仓库，属于本机运行时数据。
   */
  decisionsFile: path.join(os.homedir(), '.dsh', 'finish-line.decisions.jsonl'),
}

/** 代答的系统提示（人格文件之后追加）。 */
const PERSONA_RULES = [
  '',
  '硬性规则：',
  '1. 只能从给出的 options 里选 label，不要发明新选项；只有所有选项都不合适，才用 custom 补充理由。',
  '2. 单选：selected 恰好一个；给 custom 时 selected 置空（custom 覆盖单选）。',
  '3. 多选：selected 可多个，可再补 custom。',
  '4. 没有 options 的问题（纯填空）：selected 为空，只能给 custom。',
  '5. 只输出一个 JSON 对象，不要 Markdown、不要解释：',
  '   {"answers":[{"id":"<问题id>","selected":["<选项label>"],"custom":"<可选>"}]}',
  '6. 每个问题的 id 必须恰好出现一次；不确定时选最保守的那个选项，并在 custom 里写一句为什么。',
].join('\n')

/* ------------------------------------------------------------------ *
 * 配置与工具
 * ------------------------------------------------------------------ */

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** 校验并合并默认配置（导出便于单测）。 */
export function resolveConfig(config = {}) {
  const merged = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const persona = { ...DEFAULTS.persona, ...(merged.persona && typeof merged.persona === 'object' ? merged.persona : {}) }
  const subagent = { ...DEFAULTS.subagent, ...(merged.subagent && typeof merged.subagent === 'object' ? merged.subagent : {}) }
  const stages = Array.isArray(merged.stages) && merged.stages.length > 0 ? merged.stages : DEFAULTS.stages
  return {
    enabled: merged.enabled !== false,
    executor: merged.executor === 'session' ? 'session' : 'subagent',
    dryRun: merged.dryRun === true,
    idleMs: Math.round(clampNumber(merged.idleMs, 30000, 2 * 60 * 60 * 1000, DEFAULTS.idleMs)),
    requireToolCall: merged.requireToolCall !== false,
    maxChainAgeMs: Math.round(clampNumber(merged.maxChainAgeMs, 60000, 7 * 24 * 3600 * 1000, DEFAULTS.maxChainAgeMs)),
    gitTimeoutMs: Math.round(clampNumber(merged.gitTimeoutMs, 1000, 60000, DEFAULTS.gitTimeoutMs)),
    stages: stages
      .filter((stage) => stage && typeof stage === 'object' && typeof stage.prompt === 'string' && stage.prompt.trim() !== '')
      .map((stage, index) => ({
        id: nonEmptyString(stage.id, `stage-${index + 1}`),
        titlePrefix: nonEmptyString(stage.titlePrefix, `收尾${index + 2}`),
        prompt: stage.prompt.trim(),
      })),
    subagent: {
      provider: nonEmptyString(subagent.provider, 'spawn'),
      agentOptions: subagent.agentOptions !== null && typeof subagent.agentOptions === 'object' ? subagent.agentOptions : null,
      decideKeywords: Array.isArray(subagent.decideKeywords) && subagent.decideKeywords.length > 0
        ? subagent.decideKeywords.map(String)
        : DEFAULTS.subagent.decideKeywords,
      decideMaxWaitMs: Math.round(clampNumber(subagent.decideMaxWaitMs, 60000, 3600000, DEFAULTS.subagent.decideMaxWaitMs)),
    },
    persona: {
      file: nonEmptyString(persona.file, DEFAULTS.persona.file),
      maxContextBytes: Math.round(clampNumber(persona.maxContextBytes, 4096, 262144, DEFAULTS.persona.maxContextBytes)),
      maxOutputTokens: Math.round(clampNumber(persona.maxOutputTokens, 128, 4096, DEFAULTS.persona.maxOutputTokens)),
      timeoutMs: Math.round(clampNumber(persona.timeoutMs, 10000, 600000, DEFAULTS.persona.timeoutMs)),
      retries: Math.round(clampNumber(persona.retries, 0, 3, DEFAULTS.persona.retries)),
    },
    logFile: nonEmptyString(merged.logFile, DEFAULTS.logFile),
    decisionsFile: nonEmptyString(merged.decisionsFile, DEFAULTS.decisionsFile),
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function guardHome() {
  return process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

function stateFile() {
  return path.join(guardHome(), 'finish-line.state.json')
}

/* ------------------------------------------------------------------ *
 * 提示词与标题（导出便于单测）
 * ------------------------------------------------------------------ */

/** 收尾会话标题：「收尾② 组件化整理 ← 原标题」，80 字节内。 */
export function stageTitle(stage, rootTitle) {
  const base = (rootTitle ?? '').trim() || '未命名会话'
  const head = `${stage.titlePrefix} ← `
  const budget = 80
  const headBytes = Buffer.byteLength(head, 'utf8')
  const room = Math.max(4, budget - headBytes)
  let tail = base
  while (Buffer.byteLength(tail, 'utf8') > room && tail.length > 0) tail = tail.slice(0, -1)
  return `${head}${tail}`
}

/**
 * 首条提示就只是那一步的原话，一个字都不多：上下文/人格/协议一律不预置。
 * 人格介入不靠告诉子代理任何协议，靠插件对汇报的信号检测自动触发。
 */
export function buildStagePrompt(stage) {
  return stage.prompt
}

/**
 * 把一次人格代答格式化成会话里肉眼可读的消息：问题、全部选项、人格选择。
 * 这条消息会以 user/message 追加进收尾会话，用户随时能看到、复盘。
 * @param {Array} questions 宿主给的原始问题（含 options）
 * @param {Array} answers 人格给出的答案（{id, selected, custom?}）
 */
export function formatDecisionMessage(questions, answers) {
  const lines = ['【人格代答】收尾会话的提问已由蒸馏人格替你决定：']
  for (const question of questions) {
    const answer = answers.find((item) => item && item.id === question.id)
    lines.push('')
    const head = question.header !== undefined && question.header !== '' ? `${question.header} — ` : ''
    lines.push(`问题：${head}${question.question ?? ''}`)
    if (Array.isArray(question.options) && question.options.length > 0) {
      lines.push('选项：')
      for (const option of question.options) {
        const desc = option.description !== undefined && option.description !== '' ? `：${option.description}` : ''
        lines.push(`- ${option.label}${desc}`)
      }
    }
    let chosen = '（无记录）'
    if (answer !== undefined) {
      chosen = answer.custom !== undefined && answer.selected.length === 0
        ? answer.custom
        : answer.selected.join(' / ')
    }
    lines.push(`人格选择：${chosen}`)
  }
  return lines.join('\n')
}

/** 把问题裁剪成给模型看的形状（不出卖宿主内部对象）。 */
export function questionsForModel(questions) {
  return questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    detail: question.detail,
    multiSelect: question.multiSelect === true,
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
    })),
  }))
}

/**
 * 校验模型给出的答案：每个问题恰好一条、选项 label 必须来自问题本身。
 * @throws 校验失败时抛错，调用方降级给真人。
 */
export function validateAnswers(raw, questions) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.answers)) throw new Error('答案不是 {answers:[...]}')
  const out = []
  for (const question of questions) {
    const item = raw.answers.find((entry) => entry && entry.id === question.id)
    if (item === undefined) throw new Error(`问题 ${question.id} 没有答案`)
    const options = question.options ?? []
    const rawSelected = Array.isArray(item.selected) ? item.selected : []
    const selected = rawSelected.filter((label) => typeof label === 'string' && options.some((option) => option.label === label))
    const custom = typeof item.custom === 'string' && item.custom.trim() !== '' ? item.custom.trim() : undefined
    if (options.length === 0) {
      if (custom === undefined) throw new Error(`问题 ${question.id} 没有选项，需要 custom 文本`)
      out.push({ id: question.id, selected: [], custom })
      continue
    }
    if (question.multiSelect) {
      if (selected.length === 0 && custom === undefined) throw new Error(`问题 ${question.id} 是多选，但没选任何项`)
      out.push({ id: question.id, selected, ...(custom === undefined ? {} : { custom }) })
      continue
    }
    if (custom !== undefined) {
      out.push({ id: question.id, selected: [], custom })
      continue
    }
    if (selected.length !== 1) throw new Error(`问题 ${question.id} 是单选，需要恰好一个选项`)
    out.push({ id: question.id, selected })
  }
  return { answers: out }
}

/** 从模型输出里抠出 JSON（容忍 ```json 包裹与前后废话）。 */
export function parseAnswerJson(text) {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') throw new Error('模型没有输出')
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象')
  return JSON.parse(candidate.slice(start, end + 1))
}

/** 子代理汇报里出现「定不了」的信号，才请人格出场。 */
export function needsDecision(text, keywords) {
  if (typeof text !== 'string' || text === '') return false
  return keywords.some((keyword) => typeof keyword === 'string' && keyword !== '' && text.includes(keyword))
}

/**
 * 除 `selfId` 之外的 agent 是否都空闲（不在跑 turn、无排队输入）。
 *
 * 必须排除自己：触发评估的会话刚 turn/end，`agent.status` 可能还没落到
 * idle。把它算进去就会误判成「还有会话在跑」，而它不会再产生 turn/end，
 * 收尾就永远不触发（2026-11-26 session-c9f08656 就是这么漏的）。
 * @param {Array} agents 本项目内的 agent 列表
 * @param {string} selfId 触发本次评估的会话 id
 */
export function othersIdle(agents, selfId) {
  return agents
    .filter((agent) => agent !== undefined && agent?.session?.id !== selfId)
    .every((agent) => agent.status !== 'running'
      && (Array.isArray(agent.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0) === 0
      && (Array.isArray(agent.inbox?.nextStep) ? agent.inbox.nextStep.length : 0) === 0)
}

/** 从子代理结果里取纯文本（写日志用）。 */
export function resultText(result) {
  try {
    const blocks = Array.isArray(result?.output) ? result.output : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  } catch {
    // 往下走
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/** 宿主插件入口。 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const chains = new Map()
  const stageSessions = new Map()
  /** 项目级静默计时器：key（workspaceId 或 cwd）→ { timer, sessionId }。 */
  const projectTimers = new Map()
  const toolCalled = new Map()
  const aborts = new Map()
  const childWaiters = new Map()
  /** 每个会话最近一次 turn/end 的 reason.kind（completed / error / aborted / …）。 */
  const turnEnds = new Map()
  let personaCache

  /* ---------------- 日志与状态 ---------------- */

  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`
    try {
      fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true })
      fs.appendFileSync(cfg.logFile, `${line}\n`, 'utf8')
    } catch {
      // 日志失败不影响主流程
    }
    if (cfg.dryRun) console.log(`[finish-line] ${message}`)
  }

  /**
   * 决策台账：把人格代答/拍板的完整上下文落盘，供事后复盘。
   * 一条 JSONL = 一次决策；写失败只记日志，绝不影响收尾主流程。
   * @param {object} entry 决策记录（kind / questions / answers / decision …）
   */
  function recordDecision(entry) {
    const row = { at: new Date().toISOString(), ...entry }
    try {
      fs.mkdirSync(path.dirname(cfg.decisionsFile), { recursive: true })
      fs.appendFileSync(cfg.decisionsFile, `${JSON.stringify(row)}\n`, 'utf8')
    } catch (error) {
      log(`写决策台账失败（不影响收尾）：${describeError(error)}`)
    }
  }

  function normalizeChain(raw) {
    return {
      rootId: String(raw.rootId ?? ''),
      cwd: String(raw.cwd ?? ''),
      workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : undefined,
      rootTitle: String(raw.rootTitle ?? ''),
      stageIndex: Number.isFinite(Number(raw.stageIndex)) ? Number(raw.stageIndex) : 0,
      currentSessionId: String(raw.currentSessionId ?? ''),
      sessions: Array.isArray(raw.sessions) ? raw.sessions.map(String) : [],
      status: raw.status === 'done' || raw.status === 'failed' ? raw.status : 'running',
      startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : 0,
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    }
  }

  function loadState() {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return
      log(`读取状态失败（忽略并重建）：${describeError(error)}`)
      return
    }
    const rows = parsed && typeof parsed === 'object' ? parsed.chains : undefined
    if (rows === null || typeof rows !== 'object') return
    const now = Date.now()
    for (const [rootId, raw] of Object.entries(rows)) {
      const chain = normalizeChain({ ...(raw ?? {}), rootId })
      if (chain.rootId === '' || now - chain.updatedAt > STATE_RETENTION_MS) continue
      chains.set(chain.rootId, chain)
      for (const sessionId of chain.sessions) if (sessionId !== '') stageSessions.set(sessionId, chain.rootId)
    }
  }

  function persist() {
    const now = Date.now()
    const rows = [...chains.values()]
      .filter((chain) => now - chain.updatedAt <= STATE_RETENTION_MS)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, STATE_MAX_CHAINS)
    try {
      const file = stateFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify({ version: 1, chains: Object.fromEntries(rows.map((chain) => [chain.rootId, chain])) }, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, file)
    } catch (error) {
      log(`写状态失败：${describeError(error)}`)
    }
  }

  /* ---------------- 宿主服务 ---------------- */

  function sessionsService() {
    return ctx.get('sessions')
  }

  function liveAgent(sessionId) {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    return agents.get(sessionId)
  }

  function sessionCwd(session) {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
        const resolved = workingDirectory.get(session)
        if (typeof resolved === 'string' && resolved !== '') return resolved
      }
    } catch {
      // 退回 header
    }
    return session.header.cwd ?? process.cwd()
  }

  function workspaceOf(session) {
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return undefined
      for (const workspace of registry.list()) {
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(session.id)) return workspace
      }
    } catch {
      // 没有工作区服务时退回 cwd
    }
    return undefined
  }

  function selectedPreset(session) {
    try {
      const selected = ctx.get('sessionProjections')?.stateOf(session, 'agentPreset')
      if (typeof selected === 'string' && selected !== '') return selected
    } catch {
      // 退回 header
    }
    return session.header.agentPreset
  }

  function sessionTitle(session) {
    try {
      const title = ctx.get('sessionProjections')?.stateOf(session, 'title')
      if (typeof title === 'string' && title !== '') return title
    } catch {
      // 退回空标题
    }
    return ''
  }

  /**
   * 只看排队输入是否清空，不看 agent.status。
   * 病根：turn/end 提交时 agent.status 还是 'running'，要等 driver 后续微任务
   * 才落到 'idle'。若这里看 status，刚结束的会话会被判成「还在跑」，而它不会
   * 再产生下一次 turn/end，于是永远不再评估。
   */
  function inboxIdle(session) {
    const agent = liveAgent(session.id)
    if (agent === undefined) return true
    const nextTurn = Array.isArray(agent.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0
    const nextStep = Array.isArray(agent.inbox?.nextStep) ? agent.inbox.nextStep.length : 0
    return nextTurn === 0 && nextStep === 0
  }

  /** 一个 agent 是否彻底空闲：不在跑 turn（含等审批/等回答），也没有排队输入。 */
  function agentIdle(agent) {
    if (agent === undefined) return true
    if (agent.status === 'running') return false
    const nextTurn = Array.isArray(agent.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0
    const nextStep = Array.isArray(agent.inbox?.nextStep) ? agent.inbox.nextStep.length : 0
    return nextTurn === 0 && nextStep === 0
  }

  /** 所有顶层会话（root agents）。 */
  function rootAgents() {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.roots !== 'function') return []
    return agents.roots()
  }

  /**
   * 当前会话「本项目」的会话 id 集合：同一 workspace 内的会话。
   * 拿不到 workspace 时退回「同一个 cwd 的顶层会话」，绝不去等别的项目。
   */
  function projectSessionIds(session) {
    const workspace = workspaceOf(session)
    if (workspace !== undefined && Array.isArray(workspace.sessionIds) && workspace.sessionIds.length > 0) {
      return workspace.sessionIds
    }
    const cwd = sessionCwd(session)
    const ids = rootAgents()
      .filter((agent) => agent?.session !== undefined && sessionCwd(agent.session) === cwd)
      .map((agent) => agent.session.id)
    if (!ids.includes(session.id)) ids.push(session.id)
    return ids
  }

  /** 本项目内的顶层 agent 列表（只算本项目，别的项目不参与）。 */
  function projectAgents(session) {
    const ids = new Set(projectSessionIds(session))
    const scoped = rootAgents().filter((agent) => ids.has(agent?.session?.id))
    return scoped.length > 0 ? scoped : [liveAgent(session.id)].filter(Boolean)
  }

  /**
   * 本项目内除「触发本次评估的会话自己」以外的会话是否都空闲。
   * 必须排除自己：它刚 turn/end，status 可能还没落到 idle；把它算进去就会
   * 出现「本项目还有 1 个会话在跑」——而那个 1 个正是它自己，之后它不会
   * 再产生 turn/end，收尾就永远不触发。
   */
  function allProjectIdle(session) {
    return othersIdle(projectAgents(session), session.id)
  }

  /** 本项目内是否已有正在跑的收尾链——同一工作区只允许一条，避免多会话各跑一遍。 */
  function projectHasRunningChain(session) {
    const workspaceId = workspaceOf(session)?.id
    const cwd = sessionCwd(session)
    for (const chain of chains.values()) {
      if (chain.status !== 'running') continue
      if (workspaceId !== undefined && chain.workspaceId !== undefined) {
        if (chain.workspaceId === workspaceId) return true
      } else if (chain.cwd === cwd) {
        return true
      }
    }
    return false
  }

  /** 本项目内本轮是否有会话真正调过工具（纯问答项目不触发收尾）。 */
  function projectHadToolCall(session) {
    return projectAgents(session).some((agent) => {
      const id = agent?.session?.id
      if (typeof id !== 'string') return false
      const scoped = sessionsService()?.get(id)
      return scoped !== undefined && hasToolCall(scoped)
    })
  }

  /** 本项目内本轮是否有会话的回合是 completed（被额度卡断/中断的不算）。 */
  function projectHasCompletedTurn(session) {
    return projectAgents(session).some((agent) => {
      const id = agent?.session?.id
      return typeof id === 'string' && turnEnds.get(id) === 'completed'
    })
  }

  function hasToolCall(session) {
    if (toolCalled.get(session.id) === true) return true
    try {
      const events = Array.isArray(session.events) ? session.events : []
      for (let index = events.length - 1; index >= 0 && index >= events.length - 300; index -= 1) {
        if (events[index]?.type === 'tool/call') {
          toolCalled.set(session.id, true)
          return true
        }
      }
    } catch {
      // 读不到就从没有算
    }
    return false
  }

  /* ---------------- git ---------------- */

  function runGit(cwd, args) {
    return new Promise((resolve) => {
      execFile('git', ['-C', cwd, ...args], { timeout: cfg.gitTimeoutMs, maxBuffer: 1 << 20 }, (error, stdout) => {
        resolve(error ? null : stdout)
      })
    })
  }

  async function gitInfo(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return { repo: false, dirty: false }
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (inside === null || inside.trim() !== 'true') return { repo: false, dirty: false }
    const [status, branch, stat] = await Promise.all([
      runGit(cwd, ['status', '--porcelain=v1']),
      runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      runGit(cwd, ['diff', '--stat', 'HEAD']),
    ])
    const porcelain = (status ?? '').trim()
    return {
      repo: true,
      dirty: porcelain !== '',
      status: porcelain,
      branch: (branch ?? '').trim(),
      stat: (stat ?? '').trim(),
    }
  }

  /* ---------------- 链 ---------------- */

  function isStageSession(sessionId) {
    return stageSessions.has(sessionId)
  }

  /** 项目标识：同一 workspace 算一个项目；拿不到就用 cwd。 */
  function projectKey(session) {
    return workspaceOf(session)?.id ?? sessionCwd(session)
  }

  /**
   * 记一次「本项目有动静」：重置静默计时。
   * 任何活动（继续说话、新开会话、别的会话干活）都调这个；只有整整
   * cfg.idleMs（默认 20 分钟）内一次动静都没有，才真正去评估收尾。
   */
  function touchProject(session) {
    const key = projectKey(session)
    const previous = projectTimers.get(key)
    if (previous !== undefined) clearTimeout(previous.timer)
    const sessionId = session.id
    const timer = setTimeout(() => {
      projectTimers.delete(key)
      const live = sessionsService()?.get(sessionId) ?? session
      void evaluate(live).catch((error) => log(`评估会话 ${sessionId} 失败：${describeError(error)}`))
    }, cfg.idleMs)
    timer.unref?.()
    projectTimers.set(key, { timer, sessionId })
  }

  /** 手动触发时清掉本项目的静默计时器，避免稍后又自动触发一次。 */
  function clearProjectTimer(session) {
    const key = projectKey(session)
    const entry = projectTimers.get(key)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      projectTimers.delete(key)
    }
  }

  /** stage 会话结束时立即推进链，不参与静默期。 */
  function scheduleImmediate(session) {
    const timer = setTimeout(() => {
      void evaluate(session).catch((error) => log(`推进收尾链失败：${describeError(error)}`))
    }, 0)
    timer.unref?.()
  }

  /**
   * 尝试启动收尾链。自动触发（静默期到期）与手动触发（`/finish` 命令、
   * HTTP 路由）共用同一套门禁和同一条链；手动只是跳过静默期等待。
   * 「本项目已有链在跑 / 还有会话在跑」一律拒绝，保证全项目只有一条收尾。
   * @param {object} session 发起会话
   * @returns {Promise<{ok: boolean, text: string, busy?: boolean}>}
   */
  async function tryStartChain(session) {
    // 该会话上一条已结束（done / failed）的旧链不挡新一轮：清掉后按本轮重新判定。
    if (chains.has(session.id)) {
      const existing = chains.get(session.id)
      if (existing.status !== 'running') {
        chains.delete(session.id)
        for (const sid of existing.sessions) stageSessions.delete(sid)
        log(`会话 ${session.id} 上有一条已结束的旧链（${existing.status}），清掉后按本轮重新判定`)
      } else {
        return { ok: false, text: '该会话的收尾链还在运行。' }
      }
    }

    // 同一工作区只跑一条收尾链，不管是谁、从哪个会话触发的。
    if (projectHasRunningChain(session)) {
      return { ok: false, text: '本项目已有收尾链在跑，等它结束再来。' }
    }

    // 本项目其它会话必须都空闲（排除刚结束的触发者自己）。
    if (!allProjectIdle(session)) {
      const busy = projectAgents(session)
        .filter((agent) => agent?.session?.id !== session.id && !agentIdle(agent)).length
      return { ok: false, busy: true, text: `本项目还有 ${busy} 个其它会话在跑或排队，等它们结束再来。` }
    }

    if (!inboxIdle(session)) {
      return { ok: false, text: '该会话还有排队输入，等它跑完再来。' }
    }
    if (cfg.requireToolCall && !projectHadToolCall(session)) {
      return { ok: false, text: '本项目本轮没干过活（没有工具调用），不启动收尾。' }
    }
    if (!projectHasCompletedTurn(session)) {
      return { ok: false, text: '本项目本轮没有正常完成的回合（被中断或额度卡断），不启动收尾。' }
    }

    const cwd = sessionCwd(session)
    const git = await gitInfo(cwd)
    if (!git.repo) return { ok: false, text: `会话不在 Git 仓库（${cwd}），没有可收尾的东西。` }
    if (!git.dirty) return { ok: false, text: `工作区干净（${cwd}），没有未提交改动。` }
    const changed = git.status.split('\n').length
    if (cfg.dryRun) return { ok: false, text: `[dry-run] 有 ${changed} 项改动，本该启动收尾。` }

    clearProjectTimer(session)
    await startChain(session, cwd, git)
    return { ok: true, text: `已启动收尾：组件化整理 → 批判提交（${changed} 项改动）。` }
  }

  async function evaluate(stale) {
    const session = sessionsService()?.get(stale.id) ?? stale
    if (session.header.origin === 'subagent') return

    // 收尾链自己的阶段会话结束后推进下一步；推进不受「全空闲」门禁影响。
    const chainRootId = stageSessions.get(session.id)
    if (chainRootId !== undefined) {
      await advance(chainRootId, session)
      return
    }

    const result = await tryStartChain(session)
    if (result.ok) return
    log(`不启动收尾：${result.text}`)
    // 若只是本项目别的会话还在跑，20 分钟后再看一次（防对方长时间静默但在跑）。
    if (result.busy === true) touchProject(session)
  }

  async function startChain(root, cwd, git) {
    const chain = {
      rootId: root.id,
      cwd,
      workspaceId: workspaceOf(root)?.id,
      rootTitle: sessionTitle(root),
      stageIndex: 0,
      currentSessionId: '',
      sessions: [],
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    chains.set(root.id, chain)
    persist()
    log(`启动收尾链 root=${root.id} cwd=${cwd} 改动=${git.status.split('\n').length}项 执行器=${cfg.executor}`)
    if (cfg.executor === 'subagent') {
      void runSubagentChain(chain).catch((error) => {
        chain.status = 'failed'
        chain.updatedAt = Date.now()
        persist()
        log(`子代理收尾链失败：${describeError(error)}`)
      })
      return
    }
    await createStageSession(chain)
  }

  /* ---------------- 执行器 A：子代理（默认） ---------------- */

  async function runSubagentChain(chain) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined || typeof subagents.startActivation !== 'function') throw new Error('缺少 subagents 服务')
    for (let stageIndex = 0; stageIndex < cfg.stages.length; stageIndex += 1) {
      chain.stageIndex = stageIndex
      chain.updatedAt = Date.now()
      persist()

      const parent = liveAgent(chain.rootId)
      if (parent === undefined) throw new Error(`父会话 ${chain.rootId} 的 agent 已不在线`)
      const root = sessionsService()?.get(chain.rootId)
      const stage = cfg.stages[stageIndex]
      const abort = new AbortController()
      aborts.set(chain.rootId, abort)
      // 首条提示就一句原话，一个字不多；不传 agentOptions：spawn 继承父会话
      // 的满血模型。
      const request = {
        prompt: [{ type: 'text', text: buildStagePrompt(stage) }],
        parent,
        cwd: chain.cwd,
        maxDepth: 1,
      }
      const preset = root === undefined ? undefined : selectedPreset(root)
      if (preset !== undefined && preset !== '') request.agentPreset = preset
      if (cfg.subagent.agentOptions !== null) request.agentOptions = cfg.subagent.agentOptions

      const activation = await subagents.startActivation({
        provider: cfg.subagent.provider,
        label: `${stage.titlePrefix} · ${chain.rootTitle || chain.rootId}`.slice(0, 60),
        request,
        signal: abort.signal,
        delivery: 'caller',
      })
      chain.currentSessionId = activation.childId
      chain.sessions.push(activation.childId)
      chain.updatedAt = Date.now()
      persist()
      log(`收尾第 ${stageIndex + 1} 步子代理已启动 ${activation.childId}（${stage.id}）`)

      const result = await activation.result
      const summary = resultText(result)
      log(`收尾第 ${stageIndex + 1} 步结束 stopReason=${String(result.stopReason)} 输出=${summary === '' ? '（空）' : summary.slice(0, 4000)}`)
      if (result.diagnostic !== undefined) log(`收尾第 ${stageIndex + 1} 步诊断：${String(result.diagnostic)}`)
      if (result.stopReason !== 'completed') {
        chain.status = 'failed'
        chain.updatedAt = Date.now()
        persist()
        log(`收尾链 ${chain.rootId} 在第 ${stageIndex + 1} 步停止（${String(result.stopReason)}）`)
        return
      }

      // 子代理定不了 → 必然把人格请出来拍板，决定发回同一个子代理（非开关）。
      // 拍板失败不作假成功：链标记 failed，把卡点原样留在日志里等人看。
      if (needsDecision(summary, cfg.subagent.decideKeywords)) {
        log(`收尾第 ${stageIndex + 1} 步子代理说定不了，请人格拍板`)
        try {
          const resumed = await decideAndContinue(chain, activation.childId, stage, summary, abort.signal)
          if (resumed !== '') log(`收尾第 ${stageIndex + 1} 步（人格拍板后）输出=${resumed.slice(0, 4000)}`)
        } catch (error) {
          chain.status = 'failed'
          chain.updatedAt = Date.now()
          persist()
          log(`人格拍板失败，收尾链 ${chain.rootId} 在第 ${stageIndex + 1} 步停下（不作假成功）。卡点原文：${summary.slice(0, 2000)}；原因：${describeError(error)}`)
          return
        }
      }

      chain.updatedAt = Date.now()
      persist()
    }
    aborts.delete(chain.rootId)
    chain.status = 'done'
    chain.updatedAt = Date.now()
    persist()
    log(`收尾链 ${chain.rootId} 全部完成（${chain.sessions.length} 个子代理）`)
  }

  /** 把人格的决定发回同一个子代理，等它这一轮跑完。 */
  async function decideAndContinue(chain, childId, stage, summary, signal) {
    const subagents = ctx.get('subagents')
    const parent = liveAgent(chain.rootId)
    if (subagents === undefined || parent === undefined) throw new Error('父会话或 subagents 不可用')
    const session = sessionsService()?.get(childId) ?? sessionsService()?.get(chain.rootId)
    const decision = await personaDecide(stage, summary, session)
    if (decision === '') throw new Error('人格没有给出决定')
    // 台账：子代理卡在哪里、人格拍了什么板，供事后复盘。
    recordDecision({
      kind: 'decide',
      rootSessionId: chain.rootId,
      stageSessionId: childId,
      stageId: stage.id,
      stageTitle: stage.titlePrefix,
      stuckReport: summary,
      decision,
    })
    const wait = waitChildTurnEnd(childId, cfg.subagent.decideMaxWaitMs)
    await subagents.sendMessage(parent, childId, [{
      type: 'text',
      text: `【按用户风格拍板】${decision}\n按此继续做完，不要再回头问。`,
    }], { signal })
    log(`已把拍板发给子代理 ${childId}：${decision.slice(0, 300)}`)
    return await wait
  }

  function waitChildTurnEnd(childId, timeoutMs) {
    return new Promise((resolve) => {
      const entry = { done: false, timer: undefined, finish: undefined }
      const finish = (value) => {
        if (entry.done === true) return
        entry.done = true
        clearTimeout(entry.timer)
        const set = childWaiters.get(childId)
        if (set !== undefined) {
          set.delete(entry)
          if (set.size === 0) childWaiters.delete(childId)
        }
        resolve(value)
      }
      entry.finish = finish
      entry.timer = setTimeout(() => finish(''), timeoutMs)
      entry.timer.unref?.()
      const set = childWaiters.get(childId) ?? new Set()
      set.add(entry)
      childWaiters.set(childId, set)
    })
  }

  function lastAssistantText(session) {
    try {
      const events = Array.isArray(session.events) ? session.events : []
      for (let index = events.length - 1; index >= 0 && index >= events.length - 60; index -= 1) {
        if (events[index]?.type !== 'assistant/message') continue
        const blocks = events[index].data?.message?.content
        if (!Array.isArray(blocks)) continue
        const text = blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim()
        if (text !== '') return text
      }
    } catch {
      // 读不到就算空
    }
    return ''
  }

  async function personaDecide(stage, summary, session) {
    const system = [
      readPersona(),
      '',
      '用户此刻不在场。你要替他把这个卡住的地方定下来：',
      '直接给可执行的决定，1-3 句；不要解释你的人格、不要 JSON、不要复述问题。',
    ].join('\n')
    const userText = `收尾步骤：${stage.id}\n子代理说自己卡住了，它的汇报：\n${summary.slice(0, 4000)}\n\n请给出一句可以执行的决定。`
    let lastError
    for (let attempt = 0; attempt <= cfg.persona.retries; attempt += 1) {
      try {
        const text = (await streamPersonaLlm(system, userText, session)).trim()
        if (text !== '') return text
        throw new Error('人格输出为空')
      } catch (error) {
        lastError = error
        log(`人格拍板第 ${attempt + 1} 次失败：${describeError(error)}`)
      }
    }
    throw lastError ?? new Error('人格拍板失败')
  }

  /* ---------------- 执行器 B：新会话（可见，可代答） ---------------- */

  async function createStageSession(chain) {
    const controller = ctx.get('sessionController')
    if (controller === undefined) throw new Error('缺少 sessionController 服务')
    const root = sessionsService()?.get(chain.rootId)
    const stage = cfg.stages[chain.stageIndex]
    if (stage === undefined) throw new Error(`阶段 ${chain.stageIndex} 不存在`)
    const agentPreset = root === undefined ? undefined : selectedPreset(root)

    const request = chain.workspaceId !== undefined && chain.workspaceId !== ''
      ? { workspaceId: chain.workspaceId, ...(agentPreset === undefined ? {} : { agentPreset }) }
      : { cwd: chain.cwd, ...(agentPreset === undefined ? {} : { agentPreset }) }
    const created = await controller.create(request)
    chain.currentSessionId = created.sessionId
    chain.sessions.push(created.sessionId)
    chain.updatedAt = Date.now()
    stageSessions.set(created.sessionId, chain.rootId)
    persist()

    try {
      const title = stageTitle(stage, chain.rootTitle || (root === undefined ? '' : sessionTitle(root)))
      await controller.rename({ sessionId: created.sessionId, title })
    } catch (error) {
      log(`收尾会话命名失败：${describeError(error)}`)
    }

    if (cfg.dryRun) {
      log(`[dry-run] 本该在 ${created.sessionId} 发第 ${chain.stageIndex + 1} 步提示`)
      return
    }

    const text = buildStagePrompt(stage)
    const abort = new AbortController()
    try {
      await controller.prompt({
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, abort.signal)
    } catch (error) {
      chain.status = 'failed'
      chain.updatedAt = Date.now()
      persist()
      log(`第 ${chain.stageIndex + 1} 步提示发送失败（${created.sessionId}）：${describeError(error)}`)
      return
    }
    log(`收尾第 ${chain.stageIndex + 1} 步已在新会话 ${created.sessionId} 开始（${stage.id}）`)
  }

  async function advance(rootId, stageSession) {
    const chain = chains.get(rootId)
    if (chain === undefined || chain.status !== 'running') return
    if (chain.currentSessionId !== stageSession.id) return
    if (Date.now() - chain.startedAt > cfg.maxChainAgeMs) {
      chain.status = 'failed'
      chain.updatedAt = Date.now()
      persist()
      log(`收尾链 ${rootId} 超时放弃`)
      return
    }
    if (!inboxIdle(stageSession)) {
      log(`收尾会话 ${stageSession.id} 还有排队输入，暂不推进`)
      return
    }
    if (chain.stageIndex >= cfg.stages.length - 1) {
      chain.status = 'done'
      chain.updatedAt = Date.now()
      persist()
      log(`收尾链 ${rootId} 全部完成（${chain.sessions.length} 个新会话）`)
      return
    }
    chain.stageIndex += 1
    chain.updatedAt = Date.now()
    persist()
    log(`收尾链 ${rootId} 推进到第 ${chain.stageIndex + 1} 步`)
    try {
      await createStageSession(chain)
    } catch (error) {
      chain.status = 'failed'
      chain.updatedAt = Date.now()
      persist()
      log(`收尾链 ${rootId} 第 ${chain.stageIndex + 1} 步开场失败：${describeError(error)}`)
    }
  }

  /* ---------------- 人格（蒸馏产物，随仓库存在） ---------------- */

  function readPersona() {
    if (personaCache !== undefined) return personaCache
    let text = ''
    try {
      text = fs.readFileSync(cfg.persona.file, 'utf8').trim()
    } catch (error) {
      throw new Error(`人格文件缺失/不可读（${cfg.persona.file}）：${describeError(error)}。本插件的人格随仓库分发，丢了这个文件等于安装损坏`)
    }
    if (text === '') throw new Error(`人格文件是空的：${cfg.persona.file}`)
    personaCache = text
    return personaCache
  }

  /** 会话最近若干条消息的文本摘要，按字节预算截断。 */
  function sessionDigest(session, maxBytes) {
    const lines = []
    try {
      const events = Array.isArray(session.events) ? session.events : []
      for (let index = events.length - 1; index >= 0 && index >= events.length - 200; index -= 1) {
        const event = events[index]
        if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue
        const blocks = event.data?.message?.content
        if (!Array.isArray(blocks)) continue
        const text = blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim()
        if (text === '') continue
        lines.unshift(`${event.type === 'user/message' ? '用户' : '助手'}：${text.slice(0, 3000)}`)
        if (Buffer.byteLength(lines.join('\n\n'), 'utf8') > maxBytes) break
      }
    } catch {
      // 摘要失败不影响代答（模型还能靠问题本身选）
    }
    const joined = lines.join('\n\n')
    if (Buffer.byteLength(joined, 'utf8') <= maxBytes) return joined
    return joined.slice(-Math.floor(maxBytes / 2))
  }

  function buildUserMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND },
    }
  }

  /**
   * 人格的推理路由：跟宿主 agentDefaultModel 的当前选择（GUI 里选的默认模型）。
   * 不配置独立路由、不指向任何特定机器；换环境自动换路由。
   */
  function personaRoute() {
    const defaultModel = ctx.get('agentDefaultModel')
    if (defaultModel === undefined || typeof defaultModel.currentSelection !== 'function') {
      throw new Error('缺少 agentDefaultModel 服务，人格拿不到当前模型路由')
    }
    const selection = defaultModel.currentSelection()
    if (typeof selection?.provider !== 'string' || selection.provider === '' || typeof selection?.model !== 'string' || selection.model === '') {
      throw new Error('agentDefaultModel 当前没有可用的 provider/model 选择')
    }
    return { provider: selection.provider, model: selection.model }
  }

  async function resolveReasoningEffort(llm, route) {
    try {
      await llm.resolveCallConfig({ provider: route.provider, model: route.model, reasoningEffort: 'off' })
      return 'off'
    } catch {
      return undefined
    }
  }

  async function callPersonaModel(questions, context, session) {
    const system = `${readPersona()}\n${PERSONA_RULES}`
    const payload = JSON.stringify({ questions, context: context === '' ? '（无摘要）' : context }, null, 2)
    return streamPersonaLlm(system, payload, session)
  }

  async function streamPersonaLlm(system, userText, session) {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('缺少 llm 服务')
    const route = personaRoute()
    const effort = await resolveReasoningEffort(llm, route)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('persona timeout')), cfg.persona.timeoutMs)
    try {
      const options = {
        provider: route.provider,
        model: route.model,
        messages: [buildUserMessage(userText)],
        system,
        maxTokens: cfg.persona.maxOutputTokens,
        sessionId: session?.id ?? 'finish-line',
        purpose: 'finish-line-persona',
        signal: controller.signal,
      }
      if (effort !== undefined) options.reasoningEffort = effort
      let text = ''
      let finish
      for await (const chunk of llm.stream(options)) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason
      }
      if (finish && finish.kind && finish.kind !== 'stop') {
        throw new Error(`人格模型 finish=${finish.kind}${finish.failure?.message ? `: ${finish.failure.message}` : ''}`)
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  async function personaAnswer(request, agent) {
    const questions = questionsForModel(request.questions)
    const context = sessionDigest(agent.session, cfg.persona.maxContextBytes)
    let lastError
    for (let attempt = 0; attempt <= cfg.persona.retries; attempt += 1) {
      try {
        const text = await callPersonaModel(questions, context, agent.session)
        return validateAnswers(parseAnswerJson(text), request.questions)
      } catch (error) {
        lastError = error
        log(`人格代答第 ${attempt + 1} 次失败：${describeError(error)}`)
      }
    }
    throw lastError ?? new Error('人格代答失败')
  }

  /* ---------------- 事件接线 ---------------- */

  ctx.on('session/event', (session, event) => {
    if (cfg.enabled !== true) return
    try {
      // 任何活动都算「本项目有动静」：继续说话、新会话开干、别的会话干活，
      // 都重置静默计时。收尾链自己的 stage 会话、以及子代理会话不算
      //（前者是链的一部分，后者属于链内部干活）。
      const isStage = stageSessions.has(session.id)
      const isSubagent = session.header?.origin === 'subagent'
      if (!isStage && !isSubagent && (event.type === 'tool/call' || event.type === 'user/message' || event.type === 'turn/start' || event.type === 'turn/end')) {
        touchProject(session)
      }
      if (event.type === 'tool/call') {
        toolCalled.set(session.id, true)
        return
      }
      if (event.type !== 'turn/end') return
      // 记下这个会话最近一次回合结束的原因，供 evaluate() 判断「活干完了」。
      turnEnds.set(session.id, event.data?.reason?.kind ?? 'unknown')
      const waiters = childWaiters.get(session.id)
      if (waiters !== undefined && waiters.size > 0) {
        setTimeout(() => {
          const text = lastAssistantText(session)
          for (const entry of waiters) entry.finish?.(text)
        }, 0)
      }
      // stage 会话结束要立即推进下一步；任务会话只重置静默计时，到期再评估。
      if (isStage) scheduleImmediate(session)
    } catch (error) {
      log(`处理会话事件失败：${describeError(error)}`)
    }
  })

  // 人格代答：只在「新会话」执行器的收尾会话里抢答（必然业务，无开关）；
  // 子代理模式靠信号检测 + 拍板发回，其它会话一律 next()，
  // 绝不干扰任务会话。
  ctx.on('user-questions/request', async (request, next) => {
    try {
      if (cfg.executor !== 'session') return next()
      const agent = request.agent
      if (agent === undefined) return next()
      const sessionId = agent.session?.id
      if (typeof sessionId !== 'string' || !isStageSession(sessionId)) return next()
      if (request.questions.some((question) => question.intent !== undefined)) {
        log(`收尾会话 ${sessionId} 的提问带 plan-review 意图，交回真人`)
        return next()
      }
      const startedAt = Date.now()
      const answer = await personaAnswer(request, agent)
      log(`收尾会话 ${sessionId} 已由人格代答（${request.questions.length} 问，${Date.now() - startedAt}ms）`)
      // 让代答肉眼可见：把问题、全部选项、人格选择作为一条消息追加进收尾会话。
      // 用 surfaceOp: 'append' 进可见消息流；source 不是 user，不会触发 agent 多跑一轮。
      if (agent.session !== undefined) {
        try {
          agent.session.append('user/message', buildUserMessage(formatDecisionMessage(request.questions, answer.answers)), { surfaceOp: 'append' })
        } catch (error) {
          log(`写会话内代答记录失败（不影响代答）：${describeError(error)}`)
        }
      }
      // 台账：问题、全部选项、人格答案，供用户事后复盘。
      const rootId = stageSessions.get(sessionId)
      const chain = rootId === undefined ? undefined : chains.get(rootId)
      const stage = chain === undefined ? undefined : cfg.stages[chain.stageIndex]
      recordDecision({
        kind: 'answer',
        rootSessionId: rootId,
        stageSessionId: sessionId,
        stageId: stage?.id,
        stageTitle: stage?.titlePrefix,
        questions: request.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          detail: question.detail,
          multiSelect: question.multiSelect === true,
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            description: option.description,
          })),
        })),
        answers: answer.answers,
      })
      // 日志里再写一行可读摘要，方便直接 tail。
      const readable = answer.answers
        .map((item) => {
          const question = request.questions.find((entry) => entry.id === item.id)
          const chosen = item.custom !== undefined && item.selected.length === 0
            ? item.custom
            : item.selected.join(' / ')
          return `${question?.header ?? item.id} → ${chosen}`
        })
        .join('；')
      log(`人格代答明细：${readable}`)
      return answer
    } catch (error) {
      log(`人格代答失败，交回真人：${describeError(error)}`)
      return next()
    }
  })

  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined || typeof agent.session?.id !== 'string') return
    if (isStageSession(agent.session.id)) {
      log(`收尾会话 ${agent.session.id} 的 agent 已就绪，代答生效`)
      return
    }
    if (agent.session.header?.origin === 'subagent') return
    // 新开会话也算「本项目有动静」：重置静默计时，避免刚开新会话就收尾。
    touchProject(agent.session)
  })

  // 手动入口一：斜杠命令 `/finish`。每个会话的 `/` 菜单里都能看到，
  // 用它跳过 20 分钟静默期、立即启动本项目收尾；同一项目只会有一次。
  ctx.inject(['commands'], (child) => {
    child.effect(
      () => child.commands.register({
        name: FINISH_COMMAND,
        description: '立即启动本项目收尾：组件化整理 + 批判提交（不等静默期）',
        handler: async (invocation) => {
          if (typeof invocation?.rawInput === 'string' && invocation.rawInput.trim() !== '') {
            return { kind: 'error', text: `/${FINISH_COMMAND} 不接受参数。` }
          }
          const session = invocation?.agent?.session
          if (session === undefined) return { kind: 'error', text: '拿不到当前会话，无法收尾。' }
          const result = await tryStartChain(session)
          log(`/${FINISH_COMMAND} 手动触发：${result.ok ? '已启动' : '未启动'} —— ${result.text}`)
          return { kind: result.ok ? 'success' : 'error', text: result.text }
        }
      }),
      'finish-line: /finish command'
    )
  })

  // 手动入口二：HTTP 路由，给将来的会话头部按钮或外部脚本用。
  ctx.inject(['connection'], (child) => {
    child.effect(
      () => child.connection.fetch.register({
        path: TRIGGER_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return jsonResponse({ ok: false, error: 'bad request' }, 400)
          }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          const session = sessionId === '' ? undefined : sessionsService()?.get(sessionId)
          if (session === undefined) return jsonResponse({ ok: false, error: 'unknown session' }, 404)
          const result = await tryStartChain(session)
          log(`HTTP 手动触发 session=${sessionId}：${result.ok ? '已启动' : '未启动'} —— ${result.text}`)
          return jsonResponse({ ok: result.ok, text: result.text })
        }
      }),
      'finish-line: trigger route'
    )
  })

  ctx.effect(() => {
    loadState()
    log(`已启用（executor=${cfg.executor}，静默 ${Math.round(cfg.idleMs / 60000)} 分钟无动静才收尾，persona=${cfg.persona.file}，dryRun=${cfg.dryRun}）`)
    return () => {
      for (const entry of projectTimers.values()) clearTimeout(entry.timer)
      projectTimers.clear()
      for (const abort of aborts.values()) abort.abort()
      aborts.clear()
    }
  })

  return {}
}
