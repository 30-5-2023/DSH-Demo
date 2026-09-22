import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  A2ABridgeError,
  type A2APublicationWindow,
  type A2ATaskId,
  type PublishedA2AFile,
} from './types.ts'

interface ActivePublication {
  readonly taskId: A2ATaskId
  readonly files: PublishedA2AFile[]
  closed: boolean
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
    const record: ActivePublication = { taskId, files: [], closed: false }
    this.active.set(sessionId, record)
    return {
      files: () => [...record.files],
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
   * Append one snapshotted file to the Session's active Task window.
   * @param sessionId - Publishing Session.
   * @param file - Immutable stored file metadata.
   */
  publish(sessionId: SessionId, file: PublishedA2AFile): void {
    const record = this.active.get(sessionId)
    if (record === undefined || record.closed) throw noActiveWindow()
    record.files.push(file)
  }
}

function noActiveWindow(message = 'Session has no active publication window.'): A2ABridgeError {
  return new A2ABridgeError('A2A_PUBLICATION_WINDOW_MISSING', message)
}
