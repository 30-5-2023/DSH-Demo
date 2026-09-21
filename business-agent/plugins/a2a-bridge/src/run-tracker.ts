import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionTurnTracker, TrackedSessionTurn } from './types.ts'

interface AttemptState {
  readonly attemptId: AssistantStreamFrame['attemptId']
  revision: number
  nextIndex: number
}

interface TrackedEntry {
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly signal: AbortSignal
  readonly onTextDelta: (delta: string) => void
  readonly resolve: (value: TrackedSessionTurn) => void
  readonly reject: (error: unknown) => void
  readonly abort: () => void
  readonly text: string[]
  turn?: number
  attempt?: AttemptState
  settled: boolean
}

function trackerClosed(): Error {
  return new Error('A2A Session turn tracker closed')
}

/** Correlates Session Controller request ids to durable turns and live output. */
export class EventSessionTurnTracker implements SessionTurnTracker {
  private readonly requests = new Map<SessionId, Map<SessionRequestId, TrackedEntry>>()
  private readonly turns = new Map<SessionId, Map<number, TrackedEntry>>()
  private readonly currentTurns = new Map<SessionId, number>()
  private readonly activeAttempts = new Map<SessionId, TrackedEntry>()
  private readonly disposeSessionListener: () => void
  private readonly disposeStreamListener: () => void
  private closed = false

  /** @param ctx - Context receiving Session-wide durable and Agent stream events. */
  constructor(ctx: Context) {
    this.disposeSessionListener = ctx.on('session/event', (session, event) => {
      const sessionId = session.id
      switch (event.type) {
        case 'turn/start':
          this.currentTurns.set(sessionId, event.data.turn)
          return
        case 'user/message': {
          const source = event.data.source
          if (source.kind !== 'user' || !('rpcId' in source)) return
          const entry = this.requests.get(sessionId)?.get(source.rpcId)
          const turn = this.currentTurns.get(sessionId)
          if (entry === undefined || turn === undefined || entry.turn !== undefined) return
          const ownedTurns = this.turns.get(sessionId) ?? new Map<number, TrackedEntry>()
          const owner = ownedTurns.get(turn)
          if (owner !== undefined && owner !== entry) {
            this.fail(entry, new Error(`Session turn ${turn} already has an A2A request owner`))
            return
          }
          entry.turn = turn
          ownedTurns.set(turn, entry)
          this.turns.set(sessionId, ownedTurns)
          return
        }
        case 'assistant/message': {
          const entry = this.turns.get(sessionId)?.get(event.data.turn)
          if (entry === undefined) return
          for (const block of event.data.message.content) {
            if (block.type === 'text') entry.text.push(block.text)
          }
          return
        }
        case 'turn/end': {
          if (this.currentTurns.get(sessionId) === event.data.turn) this.currentTurns.delete(sessionId)
          const entry = this.turns.get(sessionId)?.get(event.data.turn)
          if (entry === undefined) return
          this.succeed(entry, event.data.turn, event.data.reason)
          return
        }
        default:
          return
      }
    })
    this.disposeStreamListener = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const sessionId = agent.session.id
      if (frame.type === 'start') {
        const entry = this.turns.get(sessionId)?.get(frame.turn)
        if (entry === undefined) {
          this.activeAttempts.delete(sessionId)
          return
        }
        entry.attempt = { attemptId: frame.attemptId, revision: frame.revision, nextIndex: 0 }
        this.activeAttempts.set(sessionId, entry)
        return
      }
      const entry = this.activeAttempts.get(sessionId)
      const attempt = entry?.attempt
      if (entry === undefined || attempt === undefined || attempt.attemptId !== frame.attemptId) return
      if (frame.revision <= attempt.revision) return
      if (frame.type === 'chunk') {
        if (frame.index !== attempt.nextIndex) return
        attempt.revision = frame.revision
        attempt.nextIndex += 1
        if (frame.chunk.type !== 'text-delta') return
        try {
          entry.onTextDelta(frame.chunk.text)
        } catch (error: unknown) {
          this.fail(entry, error)
        }
        return
      }
      attempt.revision = frame.revision
      delete entry.attempt
      this.activeAttempts.delete(sessionId)
    })
  }

  /**
   * Observe one request until its exact durable turn ends.
   * @param input - Session/request identity, cancellation, and live text sink.
   * @returns Durable text and settlement reason from the owned turn.
   */
  track(input: {
    readonly sessionId: SessionId
    readonly requestId: SessionRequestId
    readonly signal: AbortSignal
    readonly onTextDelta: (delta: string) => void
  }): Promise<TrackedSessionTurn> {
    if (this.closed) return Promise.reject(trackerClosed())
    if (input.signal.aborted) return Promise.reject(input.signal.reason ?? new Error('A2A Session turn tracking aborted'))
    const sessionRequests = this.requests.get(input.sessionId) ?? new Map<SessionRequestId, TrackedEntry>()
    if (sessionRequests.has(input.requestId)) {
      return Promise.reject(new Error(`Session request ${input.requestId} is already tracked`))
    }

    return new Promise<TrackedSessionTurn>((resolve, reject) => {
      const entry: TrackedEntry = {
        ...input,
        resolve,
        reject,
        abort: () => this.fail(entry, input.signal.reason ?? new Error('A2A Session turn tracking aborted')),
        text: [],
        settled: false,
      }
      sessionRequests.set(input.requestId, entry)
      this.requests.set(input.sessionId, sessionRequests)
      input.signal.addEventListener('abort', entry.abort, { once: true })
    })
  }

  /** @returns Fulfillment after listeners detach and pending observations reject. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.disposeSessionListener()
    this.disposeStreamListener()
    const error = trackerClosed()
    for (const requests of [...this.requests.values()]) {
      for (const entry of [...requests.values()]) this.fail(entry, error)
    }
    this.currentTurns.clear()
    this.activeAttempts.clear()
  }

  private succeed(entry: TrackedEntry, turn: number, reason: TurnEndReason): void {
    if (entry.settled) return
    this.remove(entry)
    entry.resolve({ turn, text: entry.text.join(''), reason })
  }

  private fail(entry: TrackedEntry, error: unknown): void {
    if (entry.settled) return
    this.remove(entry)
    entry.reject(error)
  }

  private remove(entry: TrackedEntry): void {
    entry.settled = true
    entry.signal.removeEventListener('abort', entry.abort)
    const requests = this.requests.get(entry.sessionId)
    requests?.delete(entry.requestId)
    if (requests?.size === 0) this.requests.delete(entry.sessionId)
    if (entry.turn !== undefined) {
      const turns = this.turns.get(entry.sessionId)
      turns?.delete(entry.turn)
      if (turns?.size === 0) this.turns.delete(entry.sessionId)
    }
    if (this.activeAttempts.get(entry.sessionId) === entry) this.activeAttempts.delete(entry.sessionId)
    delete entry.attempt
  }
}
