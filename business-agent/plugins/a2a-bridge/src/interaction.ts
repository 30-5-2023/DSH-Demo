import { randomUUID } from 'node:crypto'
import { Role, type Message } from '@a2a-js/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { UserQuestionError, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  A2AContextId, A2AInteractionError, A2AQuestionWindow, A2AQuestionWindowOptions,
  A2ATaskId, ParsedInteractionAnswer,
} from './types.ts'

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

interface PendingQuestion {
  readonly questions: readonly AskUserQuestionItem[]
  readonly answer: Promise<AskUserQuestionAnswer>
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (reason: unknown) => void
  queue: Promise<void>
}

interface QuestionRecord extends A2AQuestionWindowOptions {
  readonly consumedMessageIds: Set<string>
  readonly onAbort: () => void
  readonly window: A2AQuestionWindow
  pending: PendingQuestion | undefined
  closed: boolean
}

/** Routes questions from exact live Session Agents to their A2A Task windows. */
export class A2AQuestionBroker implements Disposable {
  private readonly bySession = new Map<SessionId, QuestionRecord>()
  private readonly byTask = new Map<A2ATaskId, QuestionRecord>()
  private readonly operations = new Set<Promise<unknown>>()
  private disposed = false

  /**
   * Open one exclusive Task and Session association until cancellation or disposal.
   * @param options - Exact identities, abort signal, and durable status publishers.
   * @returns Window used by the executor to accept an answer.
   */
  open(options: A2AQuestionWindowOptions): A2AQuestionWindow {
    if (this.disposed) throw new Error('A2A question broker is disposed.')
    if (this.byTask.has(options.taskId) || this.bySession.has(options.sessionId)) {
      throw new Error('A2A Task or Session already has an active question window.')
    }
    const record: QuestionRecord = {
      ...options,
      consumedMessageIds: new Set(),
      closed: false,
      pending: undefined,
      onAbort: () => this.closeWindow(record, abortError()),
      window: {
        taskId: options.taskId,
        hasPendingQuestion: () => !record.closed && record.pending !== undefined,
        continue: message => this.continue(record, message),
        [Symbol.dispose]: () => this.closeWindow(record, abortError()),
      },
    }
    this.byTask.set(options.taskId, record)
    this.bySession.set(options.sessionId, record)
    options.signal.addEventListener('abort', record.onAbort, { once: true })
    if (options.signal.aborted) record.onAbort()
    return record.window
  }

  /**
   * Claim only questions from an Agent whose Session owns a live A2A window.
   * @param request - DSH question with optional Agent identity.
   * @param next - Next user-question answerer for unrelated requests.
   * @returns The A2A answer or the delegated answer.
   */
  async answer(request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> {
    const record = request.agent === undefined ? undefined : this.bySession.get(request.agent.id)
    if (record === undefined || record.closed) return next()
    if (record.pending !== undefined) {
      throw new UserQuestionError('A2A Task already has a pending question.', 'A2A_INTERACTION_PENDING')
    }
    const pending = createPendingQuestion(request.questions)
    record.pending = pending
    const onRequestAbort = (): void => this.closeWindow(record, abortError())
    request.signal?.addEventListener('abort', onRequestAbort, { once: true })
    if (request.signal?.aborted) onRequestAbort()
    try {
      const publication = this.track(Promise.resolve().then(() => {
        if (record.closed) return
        return record.publishInputRequired(createInputRequiredMessage({
          taskId: record.taskId,
          contextId: record.contextId,
          questions: pending.questions,
        }))
      }))
      pending.queue = publication
      await publication
      return await pending.answer
    } catch (error: unknown) {
      this.closeWindow(record, error)
      throw error
    } finally {
      request.signal?.removeEventListener('abort', onRequestAbort)
    }
  }

  /**
   * @param taskId - Exact Task whose live question window is requested.
   * @returns The active window, if the Task still owns one.
   */
  find(taskId: A2ATaskId): A2AQuestionWindow | undefined {
    return this.byTask.get(taskId)?.window
  }

  /** Reject every pending wait and remove both indexes. */
  [Symbol.dispose](): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.byTask.values()) this.closeWindow(record, abortError())
  }

  /** @returns Fulfillment after owned status publications have settled. */
  async close(): Promise<void> {
    this[Symbol.dispose]()
    await Promise.allSettled([...this.operations])
  }

  private continue(record: QuestionRecord, message: Message): Promise<'accepted' | 'invalid' | 'duplicate'> {
    const pending = record.pending
    if (record.closed || pending === undefined || record.consumedMessageIds.has(message.messageId)) {
      return Promise.resolve('duplicate')
    }
    const operation = pending.queue.then(async (): Promise<'accepted' | 'invalid' | 'duplicate'> => {
      if (record.closed || record.pending !== pending || record.consumedMessageIds.has(message.messageId)) {
        return 'duplicate'
      }
      const parsed = parseInteractionAnswer(message, pending.questions)
      if (!parsed.ok) {
        await record.publishInputRequired(createInputRequiredMessage({
          taskId: record.taskId,
          contextId: record.contextId,
          questions: pending.questions,
          error: parsed.error,
        }))
        return record.closed ? 'duplicate' : 'invalid'
      }
      await record.publishWorking()
      if (record.closed) return 'duplicate'
      record.consumedMessageIds.add(message.messageId)
      record.pending = undefined
      pending.resolve(parsed.answer)
      return 'accepted'
    }).catch((error: unknown) => {
      this.closeWindow(record, error)
      throw error
    })
    pending.queue = operation.then(() => undefined, () => undefined)
    return this.track(operation)
  }

  private closeWindow(record: QuestionRecord, reason: unknown): void {
    if (record.closed) return
    record.closed = true
    record.signal.removeEventListener('abort', record.onAbort)
    if (this.bySession.get(record.sessionId) === record) this.bySession.delete(record.sessionId)
    if (this.byTask.get(record.taskId) === record) this.byTask.delete(record.taskId)
    const pending = record.pending
    record.pending = undefined
    pending?.reject(reason)
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(
      () => { this.operations.delete(operation) },
      () => { this.operations.delete(operation) },
    )
    return operation
  }
}

function createPendingQuestion(questions: readonly AskUserQuestionItem[]): PendingQuestion {
  let resolve!: (answer: AskUserQuestionAnswer) => void
  let reject!: (reason: unknown) => void
  const answer = new Promise<AskUserQuestionAnswer>((yes, no) => { resolve = yes; reject = no })
  void answer.catch(() => {})
  return { questions: [...questions], answer, resolve, reject, queue: Promise.resolve() }
}

function abortError(): UserQuestionError {
  return new UserQuestionError('A2A question wait was aborted.', 'ASK_ABORTED')
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
