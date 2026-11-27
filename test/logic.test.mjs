import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULTS,
  buildStagePrompt,
  formatDecisionMessage,
  needsDecision,
  othersIdle,
  parseAnswerJson,
  resolveConfig,
  stageTitle,
  validateAnswers,
} from '../index.js'

const stages = [
  { id: 'a', titlePrefix: '收尾② 组件化整理', prompt: '整理公共函数' },
  { id: 'b', titlePrefix: '收尾③ 批判提交', prompt: '批判提交' },
]

test('resolveConfig 默认值：subagent 执行器、不传 agentOptions（继承父会话满血模型）', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.executor, 'subagent')
  assert.equal(cfg.subagent.agentOptions, null)
  assert.equal(cfg.requireToolCall, true)
  assert.equal(cfg.stages.length, 2)
})

test('静默期 idleMs 默认 20 分钟，越界被钳制', () => {
  assert.equal(resolveConfig({}).idleMs, 20 * 60 * 1000)
  assert.equal(resolveConfig({ idleMs: 1 }).idleMs, 30000, '低于 30 秒钳到 30 秒')
  assert.equal(resolveConfig({ idleMs: 9 * 60 * 60 * 1000 }).idleMs, 2 * 60 * 60 * 1000, '高于 2 小时钳到 2 小时')
  // 旧的 quietMs 已彻底移除，传了也不生效
  assert.ok(!('quietMs' in resolveConfig({ quietMs: 1 })))
})

test('人格不是开关：enabled/provider/model/decideOnStuck 谁传都进不来', () => {
  const cfg = resolveConfig({
    subagent: { decideOnStuck: false },
    persona: { enabled: false, provider: 'magpie', model: 'local-31-99/qwen3.8-27b' },
  })
  assert.ok(!('decideOnStuck' in cfg.subagent), 'subagent.decideOnStuck 必须不存在')
  assert.ok(!('enabled' in cfg.persona), 'persona.enabled 必须不存在')
  assert.ok(!('provider' in cfg.persona), 'persona.provider 必须不存在（人格路由跟随宿主默认模型）')
  assert.ok(!('model' in cfg.persona), 'persona.model 必须不存在（人格路由跟随宿主默认模型）')
})

test('人格文件默认随插件仓库分发，不指向用户家目录的散落文件', () => {
  const cfg = resolveConfig({})
  assert.ok(cfg.persona.file.endsWith(['persona', 'persona.md'].join('/')), `实际值：${cfg.persona.file}`)
  assert.ok(cfg.persona.file.includes('dsh-finish-line'), `实际值：${cfg.persona.file}`)
})

test('决策台账默认落在 ~/.dsh，可被配置覆盖，记录人类可读', () => {
  const cfg = resolveConfig({})
  assert.match(cfg.decisionsFile, /finish-line\.decisions\.jsonl$/)
  const custom = resolveConfig({ decisionsFile: '/tmp/x.jsonl' })
  assert.equal(custom.decisionsFile, '/tmp/x.jsonl')
})

test('formatDecisionMessage 把问题、全部选项、人格选择都写进会话可见文本', () => {
  const questions = [
    {
      id: 'q1',
      header: '杠杆倍数',
      question: '群委会主席用几倍？',
      options: [
        { label: '3 倍', description: '默认值' },
        { label: '5 倍', description: '用户指定' },
      ],
    },
    { id: 'q2', header: '保证金模式', question: '共享还是分开？', options: [] },
  ]
  const text = formatDecisionMessage(questions, [
    { id: 'q1', selected: ['5 倍'] },
    { id: 'q2', selected: [], custom: '共享' },
  ])
  assert.match(text, /杠杆倍数 — 群委会主席用几倍？/)
  assert.match(text, /- 3 倍：默认值/)
  assert.match(text, /- 5 倍：用户指定/)
  assert.match(text, /人格选择：5 倍/)
  assert.match(text, /人格选择：共享/)
})

test('stageTitle 在 80 字节内', () => {
  const title = stageTitle(stages[0], '一个很长很长很长很长很长很长很长很长很长很长很长很长的会话标题')
  assert.ok(Buffer.byteLength(title, 'utf8') <= 80)
  assert.ok(title.startsWith('收尾② 组件化整理 ← '))
})

test('两步首条提示与用户原文逐字相等，一个多余的字都没有', () => {
  assert.equal(DEFAULTS.stages[0].prompt, 'git diff 将公共函数整理到 utils 相关模块中，要求在组件化、模块化的指导思路下举一反三，以此类推；')
  assert.equal(DEFAULTS.stages[1].prompt, '调用技能 cc-git-commit 同步并推送代码，分批，注意 diff 的过程中批判下、看看有没有隐患、bug、遗漏；')
})

test('硬约束：buildStagePrompt 的输出与步骤原话逐字相等，任何额外内容都算违约', () => {
  // 这是对「不要额外提示词」的硬约束：改了 buildStagePrompt 的拼接逻辑、
  // 往子代理首条消息里塞协议或上下文，这里立刻红。
  for (const stage of [stages[0], stages[1], { id: 'x', prompt: '随便一句原话\n带换行' }, { id: 'y', prompt: '' }]) {
    assert.equal(buildStagePrompt(stage), stage.prompt, `步骤 ${stage.id} 的提示词被篡改`)
  }
  assert.equal(buildStagePrompt(stages[1]), '批判提交')
  assert.doesNotMatch(buildStagePrompt(stages[1]), /子代理|NEED-DECISION|人格|协议|流水线|风格依据/)
})

test('硬约束：源码里不得重新引入拼接额外提示词的函数或配置', () => {
  // 直接静态检查源码文本：任何人想加回 buildSubagentPrompt、subagentRules
  // 或在首条消息里拼接协议，测试直接失败。
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')
  assert.ok(!/buildSubagentPrompt/.test(source), '不允许重新引入 buildSubagentPrompt')
  assert.ok(!/subagentRules/.test(source), '不允许重新引入 persona.subagentRules')
  assert.ok(!/NEED-DECISION/.test(source), '源码里不得出现 NEED-DECISION 协议字样')
  // 两处发首条提示的位置都必须直接用 buildStagePrompt(stage)，不能有别的拼法。
  const promptHits = source.match(/text:\s*buildStagePrompt\(stage\)/g) ?? []
  assert.equal(promptHits.length, 1, `subagent 首条提示必须是 buildStagePrompt(stage)，实际命中 ${promptHits.length} 处`)
  assert.match(source, /const\s+text\s*=\s*buildStagePrompt\(stage\)/, 'session 首条提示也必须是 buildStagePrompt(stage)')
})

test('人格介入靠信号检测，不靠给子代理的额外提示词', () => {
  assert.ok(DEFAULTS.subagent.decideKeywords.includes('需要拍板'))
  assert.ok(DEFAULTS.subagent.decideKeywords.includes('无法确定'))
  assert.ok(!('subagentRules' in DEFAULTS.persona), 'persona.subagentRules 必须不存在')
})

test('needsDecision 只在子代理自认卡住时才为真', () => {
  const keywords = ['无法确定', '需要拍板', '请你决定']
  assert.equal(needsDecision('已整理完毕，提交完成。', keywords), false)
  assert.equal(needsDecision('这个选择我无法确定，需要你来定。', keywords), true)
  assert.equal(needsDecision('', keywords), false)
})

test('validateAnswers 单选/多选/自定义/无选项', () => {
  const questions = [
    { id: 'q1', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
    { id: 'q3', options: [{ label: 'C' }] },
    { id: 'q4' },
  ]
  const ok = validateAnswers({
    answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['X', 'Y'] },
      { id: 'q3', selected: [], custom: '我自己写' },
      { id: 'q4', selected: [], custom: '文本答案' },
    ],
  }, questions)
  assert.deepEqual(ok.answers[0], { id: 'q1', selected: ['A'] })
  assert.deepEqual(ok.answers[1], { id: 'q2', selected: ['X', 'Y'] })
  assert.deepEqual(ok.answers[2], { id: 'q3', selected: [], custom: '我自己写' })
  assert.deepEqual(ok.answers[3], { id: 'q4', selected: [], custom: '文本答案' })
})

test('validateAnswers 拒绝瞎选：选项标签必须存在、单选必须一个', () => {
  assert.throws(() => validateAnswers({ answers: [{ id: 'q1', selected: ['Z'] }] }, [{ id: 'q1', options: [{ label: 'A' }] }]))
  assert.throws(() => validateAnswers({ answers: [{ id: 'q1', selected: ['A', 'B'] }] }, [{ id: 'q1', options: [{ label: 'A' }, { label: 'B' }] }]))
  assert.throws(() => validateAnswers({ answers: [] }, [{ id: 'q1', options: [{ label: 'A' }] }]))
})

test('parseAnswerJson 容忍代码围栏与前后废话', () => {
  assert.deepEqual(parseAnswerJson('好的：\n```json\n{"answers":[]}\n```\n完'), { answers: [] })
  assert.deepEqual(parseAnswerJson('前言 {"answers":[]} 后语'), { answers: [] })
  assert.throws(() => parseAnswerJson('没有 JSON'))
})

test('othersIdle 必须排除触发评估的自己（status 可能尚未落 idle）', () => {
  const selfRunning = { session: { id: 'a' }, status: 'running', inbox: { nextTurn: [], nextStep: [] } }
  const otherIdle = { session: { id: 'b' }, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
  const otherRunning = { session: { id: 'c' }, status: 'running', inbox: { nextTurn: [], nextStep: [] } }
  const otherQueued = { session: { id: 'd' }, status: 'idle', inbox: { nextTurn: [{}], nextStep: [] } }

  // 只有自己还在 running（状态滞后）→ 别人都空闲 → 通过
  assert.equal(othersIdle([selfRunning], 'a'), true)
  assert.equal(othersIdle([selfRunning, otherIdle], 'a'), true)
  // 别的会话真在跑或排队 → 不通过
  assert.equal(othersIdle([selfRunning, otherIdle, otherRunning], 'a'), false)
  assert.equal(othersIdle([selfRunning, otherQueued], 'a'), false)
  // 空列表 → 通过
  assert.equal(othersIdle([], 'a'), true)
})
