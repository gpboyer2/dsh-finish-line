import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULTS,
  buildStagePrompt,
  needsDecision,
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
  assert.equal(cfg.quietMs, 20000)
  assert.equal(cfg.requireToolCall, true)
  assert.equal(cfg.stages.length, 2)
})

test('resolveConfig 拒绝非法值并钳制安静窗口', () => {
  const cfg = resolveConfig({ quietMs: 1, executor: 'whatever', stages: [] })
  assert.equal(cfg.quietMs, 3000)
  assert.equal(cfg.executor, 'subagent')
  assert.equal(cfg.stages.length, 2)
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

test('buildStagePrompt 只发一句原话，不夹上下文和人格', () => {
  const text = buildStagePrompt(stages[1])
  assert.equal(text, '批判提交')
  assert.doesNotMatch(text, /流水线上下文|风格依据|子代理/)
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
