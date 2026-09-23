import { randomUUID } from 'node:crypto'
import { Role, type Message } from '@a2a-js/sdk'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { A2AContextId, A2AInteractionError, A2ATaskId, ParsedInteractionAnswer } from './types.ts'

/** Versioned application payload identifying an input-required question. */
export const A2A_INPUT_REQUIRED_SCHEMA = 'urn:deepseek-harness:a2a:input-required:v1'
/** Versioned application payload identifying an answer to pending questions. */
export const A2A_INPUT_RESPONSE_SCHEMA = 'urn:deepseek-harness:a2a:input-response:v1'

/** Encode pending questions as standard A2A text and data Parts. */
export function createInputRequiredMessage(input: {
  readonly taskId: A2ATaskId
  readonly contextId: A2AContextId
  readonly questions: readonly AskUserQuestionItem[]
  readonly error?: A2AInteractionError
}): Message {
  const data = {
    schema: A2A_INPUT_REQUIRED_SCHEMA,
    questions: input.questions,
    ...(input.error === undefined ? {} : { error: input.error }),
  }
  const text = [
    ...(input.error === undefined ? [] : [input.error.message]),
    ...input.questions.map(renderQuestion),
  ].join('\n\n')
  return {
    messageId: randomUUID(),
    taskId: input.taskId,
    contextId: input.contextId,
    role: Role.ROLE_AGENT,
    parts: [
      { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' },
      { content: { $case: 'data', value: data }, metadata: undefined, filename: '', mediaType: 'application/json' },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

/** Validate a wire response against the exact pending question set. */
export function parseInteractionAnswer(
  message: Message,
  questions: readonly AskUserQuestionItem[],
): ParsedInteractionAnswer {
  const recognized: unknown[] = []
  const text: string[] = []
  for (const part of message.parts) {
    const content = part.content
    if (content?.$case === 'data' && isRecord(content.value) && content.value.schema === A2A_INPUT_RESPONSE_SCHEMA) {
      recognized.push(content.value)
    } else if (content?.$case === 'text' && typeof content.value === 'string' && content.value.trim() !== '') {
      text.push(content.value.trim())
    }
  }
  if (recognized.length > 0) {
    if (recognized.length !== 1) return failure('Send one structured response DataPart.')
    return parseStructured(recognized[0], questions)
  }
  const combined = text.join('\n').trim()
  if (combined === '' || questions.length === 0) return failure('Send a non-empty text or structured answer.')
  return { ok: true, answer: { answers: [{ id: questions[0]!.id, selected: [], custom: combined }] } }
}

function renderQuestion(question: AskUserQuestionItem): string {
  const lines = [`${question.id}: ${question.question}`]
  if (question.header !== undefined) lines.push(question.header)
  if (question.detail !== undefined) lines.push(question.detail)
  for (const option of question.options ?? []) {
    lines.push(`- ${option.label}${option.description === undefined ? '' : `: ${option.description}`}`)
  }
  return lines.join('\n')
}

function parseStructured(value: unknown, questions: readonly AskUserQuestionItem[]): ParsedInteractionAnswer {
  if (!isRecord(value) || !Array.isArray(value.answers)) return failure('Structured answer must contain an answers array.')
  if (value.answers.length !== questions.length) return failure('Answer every pending question exactly once.')
  const pending = new Map(questions.map(question => [question.id, question]))
  if (pending.size !== questions.length) return failure('Pending question ids must be unique.')
  const seen = new Set<string>()
  const answers: AskUserQuestionAnswerItem[] = []
  for (const raw of value.answers) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.selected)) {
      return failure('Each answer needs an id and selected array.')
    }
    const question = pending.get(raw.id)
    if (question === undefined || seen.has(raw.id)) return failure('Answer ids must match pending questions exactly once.')
    seen.add(raw.id)
    if (!raw.selected.every((label: unknown): label is string => typeof label === 'string')) {
      return failure('Selected options must be labels.')
    }
    const selected: string[] = raw.selected
    if (new Set(selected).size !== selected.length) return failure('Selected options must be unique.')
    if (question.multiSelect !== true && selected.length > 1) return failure('This question accepts one selection.')
    const labels = new Set((question.options ?? []).map(option => option.label))
    if (selected.some(label => !labels.has(label))) return failure('Select only available options.')
    if (raw.custom !== undefined && typeof raw.custom !== 'string') return failure('Custom answer must be text.')
    if ((question.options?.length ?? 0) === 0 && (typeof raw.custom !== 'string' || raw.custom.trim() === '')) {
      return failure('This question requires a custom answer.')
    }
    if (selected.length === 0 && (typeof raw.custom !== 'string' || raw.custom.trim() === '')) {
      return failure('Select an option or provide a custom answer.')
    }
    answers.push({ id: raw.id, selected, ...(raw.custom === undefined ? {} : { custom: raw.custom }) })
  }
  return { ok: true, answer: { answers } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failure(message: string): ParsedInteractionAnswer {
  return { ok: false, error: { code: 'A2A_INTERACTION_INVALID_RESPONSE', message } }
}
