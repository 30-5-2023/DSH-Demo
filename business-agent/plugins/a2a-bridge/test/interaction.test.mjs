import assert from 'node:assert/strict'
import test from 'node:test'
import { Role } from '@a2a-js/sdk'
import {
  A2AContextId,
  A2ATaskId,
  A2A_INPUT_REQUIRED_SCHEMA,
  A2A_INPUT_RESPONSE_SCHEMA,
  createInputRequiredMessage,
  parseInteractionAnswer,
} from '../lib/index.js'

const questions = [
  {
    id: 'environment',
    question: 'Select the target environment',
    header: 'Environment',
    detail: 'Deployment starts immediately.',
    options: [
      { label: 'Development', description: 'Deploy to development.' },
      { label: 'Test', description: 'Deploy to test.' },
    ],
    multiSelect: false,
    intent: { kind: 'plan-review', approve: 'Test' },
  },
]

function part(kind, value) {
  return {
    content: { $case: kind, value },
    metadata: undefined,
    filename: '',
    mediaType: kind === 'text' ? 'text/plain' : 'application/json',
  }
}

function answerMessage(parts) {
  return {
    messageId: 'answer-1', contextId: 'context-1', taskId: 'task-1',
    role: Role.ROLE_USER, parts, metadata: undefined, extensions: [], referenceTaskIds: [],
  }
}

function response(answers) {
  return part('data', { schema: 'urn:deepseek-harness:a2a:input-response:v1', answers })
}

function invalid(message, pending = questions) {
  const result = parseInteractionAnswer(message, pending)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'A2A_INTERACTION_INVALID_RESPONSE')
  assert.ok(result.error.message.length > 0)
}

test('encodes complete questions in a readable, identified Agent Message', () => {
  const input = { taskId: A2ATaskId('task-1'), contextId: A2AContextId('context-1'), questions }
  const first = createInputRequiredMessage(input)
  const second = createInputRequiredMessage(input)
  assert.equal(first.role, Role.ROLE_AGENT)
  assert.equal(first.taskId, 'task-1')
  assert.equal(first.contextId, 'context-1')
  assert.notEqual(first.messageId, second.messageId)
  assert.equal(first.parts.length, 2)
  const readable = first.parts[0].content.value
  for (const value of ['environment', 'Select the target environment', 'Environment', 'Deployment starts immediately.', 'Development', 'Deploy to development.', 'Test', 'Deploy to test.']) {
    assert.ok(readable.includes(value), value)
  }
  assert.deepEqual(first.parts[1].content.value, {
    schema: 'urn:deepseek-harness:a2a:input-required:v1', questions,
  })
  assert.equal(A2A_INPUT_REQUIRED_SCHEMA, 'urn:deepseek-harness:a2a:input-required:v1')
  assert.equal(A2A_INPUT_RESPONSE_SCHEMA, 'urn:deepseek-harness:a2a:input-response:v1')
})

test('includes a safe validation error while retaining original questions', () => {
  const error = { code: 'A2A_INTERACTION_INVALID_RESPONSE', message: 'Choose one available option.' }
  const message = createInputRequiredMessage({ taskId: A2ATaskId('task-1'), contextId: A2AContextId('context-1'), questions, error })
  assert.deepEqual(message.parts[1].content.value, {
    schema: 'urn:deepseek-harness:a2a:input-required:v1', questions, error,
  })
})

test('accepts exactly covered structured answers with selected and custom values', () => {
  const pending = [...questions, { id: 'reason', question: 'Why?' }]
  assert.deepEqual(parseInteractionAnswer(answerMessage([response([
    { id: 'environment', selected: ['Test'], custom: 'Approved after review' },
    { id: 'reason', selected: [], custom: 'Ready' },
  ])]), pending), {
    ok: true,
    answer: { answers: [
      { id: 'environment', selected: ['Test'], custom: 'Approved after review' },
      { id: 'reason', selected: [], custom: 'Ready' },
    ] },
  })
})

test('accepts multiple available selections only for multi-select questions', () => {
  const pending = [{ ...questions[0], multiSelect: true }]
  assert.equal(parseInteractionAnswer(answerMessage([response([
    { id: 'environment', selected: ['Development', 'Test'] },
  ])]), pending).ok, true)
})

test('rejects missing, duplicate, and unknown answer ids', () => {
  const pending = [...questions, { id: 'reason', question: 'Why?' }]
  invalid(answerMessage([response([{ id: 'environment', selected: ['Test'] }])]), pending)
  invalid(answerMessage([response([
    { id: 'environment', selected: ['Test'] },
    { id: 'environment', selected: ['Test'] },
  ])]))
  invalid(answerMessage([response([{ id: 'unknown', selected: ['Test'] }])]))
})

test('rejects unavailable, duplicate, and illegal multiple selections', () => {
  for (const selected of [['Production'], ['Test', 'Test'], ['Development', 'Test']]) {
    invalid(answerMessage([response([{ id: 'environment', selected }])]))
  }
})

test('rejects malformed structured fields and no-option answers without custom text', () => {
  const freeform = [{ id: 'reason', question: 'Why?' }]
  invalid(answerMessage([response([{ id: 'reason', selected: [] }])]), freeform)
  invalid(answerMessage([response([{ id: 'reason', selected: [], custom: '  ' }])]), freeform)
  invalid(answerMessage([response([{ id: 'environment', selected: 'Test' }])]))
  invalid(answerMessage([response([{ id: 'environment', selected: ['Test'], custom: 3 }])]))
  invalid(answerMessage([response('bad')]))
})

test('rejects a choice question with neither selection nor custom answer', () => {
  invalid(answerMessage([response([{ id: 'environment', selected: [] }])]))
})

test('a recognized invalid response never falls back to adjacent text', () => {
  invalid(answerMessage([
    response([{ id: 'environment', selected: ['Production'] }]),
    part('text', 'Test'),
  ]))
})

test('plain text maps to only the first question as custom', () => {
  const pending = [...questions, { id: 'reason', question: 'Why?' }]
  assert.deepEqual(parseInteractionAnswer(answerMessage([
    part('text', 'Test'), part('text', 'because staging is ready'),
  ]), pending), {
    ok: true,
    answer: { answers: [{ id: 'environment', selected: [], custom: 'Test\nbecause staging is ready' }] },
  })
})

test('rejects FilePart-only and empty text input', () => {
  invalid(answerMessage([{ ...part('raw', new Uint8Array([1])), mediaType: 'application/octet-stream' }]))
  invalid(answerMessage([part('text', '   ')]))
})
