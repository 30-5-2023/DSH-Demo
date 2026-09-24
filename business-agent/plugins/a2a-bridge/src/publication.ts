import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  A2ABridgeError,
  type A2AFilePublication,
  type A2APublicationTarget,
  type A2APublicationWindow,
  type A2ATaskId,
  type PublishedA2AFile,
} from './types.ts'

interface ActivePublication {
  readonly taskId: A2ATaskId
  readonly entries: A2AFilePublication[]
  closed: boolean
}

interface PresentedSessionEvent {
  readonly data: {
    readonly turn: number
    readonly files: readonly { readonly path: string }[]
  }
}

/** Task-scoped file publications keyed by the exact Session running that Task. */
export class A2AFilePublications {
  private readonly active = new Map<SessionId, ActivePublication>()

  /**
   * Open the sole publication window for a Session.
   * @param taskId - A2A Task that will own every published file.
   * @param sessionId - Session allowed to call the publication tool.
   * @returns Disposable ordered view of accepted files.
   */
  open(taskId: A2ATaskId, sessionId: SessionId): A2APublicationWindow {
    if (this.active.has(sessionId)) throw noActiveWindow('Session already has an active publication window.')
    const record: ActivePublication = { taskId, entries: [], closed: false }
    this.active.set(sessionId, record)
    return {
      entries: turn => record.entries.filter(entry => entry.kind === 'published' || entry.turn === turn),
      files: () => record.entries.flatMap(entry => entry.kind === 'published' ? [entry.file] : []),
      [Symbol.dispose]: () => {
        if (record.closed) return
        record.closed = true
        if (this.active.get(sessionId) === record) this.active.delete(sessionId)
      },
    }
  }

  /**
   * Fail unless a Session currently owns a publication window.
   * @param sessionId - Session selected by the tool execution context.
   */
  assertActive(sessionId: SessionId): void {
    if (this.active.get(sessionId)?.closed !== false) throw noActiveWindow()
  }

  /**
   * Capture the exact Task window that owns a publication operation.
   * @param sessionId - Session selected by the tool execution context.
   * @returns Capability that rejects after the captured window is replaced or closed.
   */
  capture(sessionId: SessionId): A2APublicationTarget {
    const record = this.active.get(sessionId)
    if (record === undefined || record.closed) throw noActiveWindow()
    return {
      publish: (file) => {
        if (record.closed || this.active.get(sessionId) !== record) throw noActiveWindow()
        record.entries.push({ kind: 'published', file })
      },
    }
  }

  /**
   * Append one snapshotted file to the Session's active Task window.
   * @param sessionId - Publishing Session.
   * @param file - Immutable stored file metadata.
   */
  publish(sessionId: SessionId, file: PublishedA2AFile): void {
    const record = this.active.get(sessionId)
    if (record === undefined || record.closed) throw noActiveWindow()
    record.entries.push({ kind: 'published', file })
  }

  /**
   * Record files explicitly delivered through present when this Session belongs to an inbound A2A Task.
   * @param sessionId - Session that emitted the durable delivery event.
   * @param workspaceRoot - Session workspace used to resolve relative paths.
   * @param turn - Session turn that owns the delivery.
   * @param files - Delivered filesystem declarations in presentation order.
   * @returns Whether the Session currently belongs to an inbound A2A Task.
   */
  present(
    sessionId: SessionId,
    workspaceRoot: string | undefined,
    turn: number,
    files: readonly { readonly path: string }[],
  ): boolean {
    const record = this.active.get(sessionId)
    if (record === undefined || record.closed) return false
    if (workspaceRoot === undefined) {
      record.entries.push({
        kind: 'failed',
        turn,
        error: new A2ABridgeError(
          'A2A_PUBLICATION_WORKSPACE_REQUIRED',
          'A presented A2A file requires a Session workspace.',
        ),
      })
      return true
    }
    for (const file of files) {
      record.entries.push({
        kind: 'presented',
        turn,
        input: { path: file.path },
        workspaceRoot,
      })
    }
    return true
  }
}

/**
 * Connect durable present deliveries to active inbound A2A publication windows.
 * @param ctx - Host context carrying the global Session event feed.
 * @param publications - Task-scoped publication registry.
 * @returns Listener disposer.
 */
export function registerPresentedFilePublications(
  ctx: Context,
  publications: Pick<A2AFilePublications, 'present'>,
): () => unknown {
  return ctx.on('session/event', (session, event) => {
    if ((event.type as string) !== 'deliverables/presented') return
    const presented = event as unknown as PresentedSessionEvent
    publications.present(session.header.id, session.header.cwd, presented.data.turn, presented.data.files)
  }, { global: true })
}

function noActiveWindow(message = 'Session has no active publication window.'): A2ABridgeError {
  return new A2ABridgeError('A2A_PUBLICATION_WINDOW_MISSING', message)
}
