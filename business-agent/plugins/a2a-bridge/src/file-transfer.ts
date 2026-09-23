import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Stats } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import type { Part } from '@a2a-js/sdk'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { A2AFileLinks } from './file-links.ts'
import {
  A2ABridgeError,
  type A2AOutboundFileInput,
  type A2ATaskId,
  type PublishedA2AFile,
  type StoredA2AFile,
} from './types.ts'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const READ_CHUNK_BYTES = 64 * 1_024

/** Filesystem operations whose ordering binds local containment to the opened file. */
export interface A2ALocalFileSystem {
  /** @param path - Path to canonicalize. @returns Its canonical path. */
  realpath(path: string): Promise<string>
  /** @param path - File to open. @param flags - Read-only mode. @returns The opened handle. */
  open(path: string, flags: 'r'): Promise<FileHandle>
  /** @param path - Canonical opened path. @returns Its current identity and metadata. */
  stat(path: string): Promise<Stats>
}

/** Runtime services and limits used for every A2A file transfer. */
export interface A2AFileTransferOptions {
  readonly attachments: Pick<AttachmentStore, 'saveFileStream' | 'readFileStream' | 'fileHostPath'>
  readonly fileUploads: Pick<FileUploads, 'uploadStream'>
  readonly maxFileBytes: number
  readonly inlineFileMaxBytes: number
  readonly fetchTimeoutMs: number
  readonly maxRedirects: number
  readonly publishFileAllowedRoots: readonly string[]
  readonly fileLinks?: Pick<A2AFileLinks, 'issue'>
  readonly fetchImpl?: typeof fetch
  readonly localFileSystem?: A2ALocalFileSystem
}

/** Reduce caller-controlled display metadata to one safe non-empty filename. */
export function safeFileName(value: string): string {
  const leaf = basename(value.replaceAll('\\', '/')).trim()
  if (leaf === '' || leaf === '.' || leaf === '..' || /[\0-\x1f\x7f]/.test(leaf)) {
    throw new A2ABridgeError('A2A_FILE_NAME_INVALID', 'A2A file name must contain one safe non-empty leaf name.')
  }
  return leaf
}

/** Validate an A2A media type or supply the generic binary default. */
export function mediaTypeOrDefault(value: string | undefined): string {
  const mediaType = value?.trim() || 'application/octet-stream'
  if (!MEDIA_TYPE.test(mediaType)) {
    throw new A2ABridgeError('A2A_MEDIA_TYPE_INVALID', 'A2A file media type must be a valid type and subtype.')
  }
  return mediaType.toLowerCase()
}

/** Yield byte chunks while enforcing cancellation and a measured aggregate limit. */
export async function *boundedBytes(
  source: AsyncIterable<Uint8Array>,
  maximum: number,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let total = 0
  try {
    for await (const chunk of source) {
      if (signal?.aborted === true) throw aborted(signal.reason)
      total += chunk.byteLength
      if (total > maximum) {
        throw new A2ABridgeError('A2A_FILE_TOO_LARGE', 'A2A file exceeds the configured byte limit.')
      }
      yield chunk
    }
    if (signal?.aborted === true) throw aborted(signal.reason)
  } catch (error: unknown) {
    if (error instanceof A2ABridgeError) throw error
    if (signal?.aborted === true) throw aborted(error)
    throw error
  }
}

/** Snapshot, admit, and materialize A2A files through DSH attachment services. */
export class A2AFileTransfer {
  private readonly fetchImpl: typeof fetch
  private readonly localFileSystem: A2ALocalFileSystem

  /** @param options - Attachment services plus deployment-owned transfer limits. */
  constructor(private readonly options: A2AFileTransferOptions) {
    if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1) {
      throw new TypeError('business-a2a-bridge: maxFileBytes must be a positive integer')
    }
    if (!Number.isSafeInteger(options.inlineFileMaxBytes) || options.inlineFileMaxBytes < 1
      || options.inlineFileMaxBytes > options.maxFileBytes) {
      throw new TypeError('business-a2a-bridge: inlineFileMaxBytes must be a positive integer within maxFileBytes')
    }
    if (!Number.isSafeInteger(options.fetchTimeoutMs) || options.fetchTimeoutMs < 1) {
      throw new TypeError('business-a2a-bridge: fetchTimeoutMs must be a positive integer')
    }
    if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0) {
      throw new TypeError('business-a2a-bridge: maxRedirects must be a non-negative integer')
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.localFileSystem = options.localFileSystem ?? {
      realpath: path => realpath(path),
      open: (path, flags) => open(path, flags),
      stat: path => stat(path),
    }
  }

  /**
   * Store one stable local file after resolving it inside the workspace or an allowed root.
   * @param input - Local path plus optional display metadata.
   * @param workspaceRoot - Workspace used to resolve relative input paths.
   * @param signal - Caller cancellation.
   * @returns Immutable stored bytes and validated media type.
   */
  async snapshotLocal(
    input: A2AOutboundFileInput,
    workspaceRoot: string,
    signal: AbortSignal,
  ): Promise<StoredA2AFile> {
    if (input.path.trim() === '') throw pathRejected()
    if (signal.aborted) throw aborted(signal.reason)
    const name = safeFileName(input.name ?? basename(input.path.replaceAll('\\', '/')))
    const mediaType = mediaTypeOrDefault(input.mime_type)
    let roots: string[]
    let candidate: string
    try {
      roots = await Promise.all([
        this.localFileSystem.realpath(workspaceRoot),
        ...this.options.publishFileAllowedRoots.map(root => this.localFileSystem.realpath(root)),
      ])
      candidate = isAbsolute(input.path) ? input.path : resolve(workspaceRoot, input.path)
    } catch (error: unknown) {
      throw pathRejected(error)
    }

    let handle
    try {
      handle = await this.localFileSystem.open(candidate, 'r')
      const before = await handle.stat()
      if (!before.isFile()) throw pathRejected()
      const openedPath = await this.localFileSystem.realpath(candidate)
      if (!roots.some(root => containsPath(root, openedPath))) throw pathRejected()
      const openedPathStat = await this.localFileSystem.stat(openedPath)
      if (!sameFile(before, openedPathStat)) throw pathRejected()
      if (before.size > this.options.maxFileBytes) {
        throw new A2ABridgeError('A2A_FILE_TOO_LARGE', 'A2A file exceeds the configured byte limit.')
      }
      const ref = await this.options.attachments.saveFileStream({
        data: boundedBytes(readHandle(handle, signal), this.options.maxFileBytes, signal),
        signal,
        name,
      })
      const after = await handle.stat()
      if (!sameFile(before, after)) {
        throw new A2ABridgeError('A2A_FILE_UNSTABLE', 'A2A local file changed while it was being snapshotted.')
      }
      return { ref, mediaType }
    } catch (error: unknown) {
      if (error instanceof A2ABridgeError) throw error
      if (signal.aborted) throw aborted(error)
      throw error
    } finally {
      await handle?.close().catch((_closeError: unknown) => {
        // The transfer result owns the operation; closing only releases the local handle.
      })
    }
  }

  /**
   * Stage one inbound raw or URL Part for a Session prompt.
   * @param part - A2A file Part.
   * @param sessionId - Receiving DSH Session.
   * @param allowedOrigin - Exact-origin deployment policy.
   * @param signal - Caller cancellation.
   * @returns Session prompt file receipt.
   */
  async uploadInboundPart(
    part: Part,
    sessionId: SessionId,
    allowedOrigin: (url: URL) => boolean,
    signal: AbortSignal,
  ): Promise<PromptContentPart> {
    const name = safeFileName(part.filename)
    const data = await this.partBytes(part, allowedOrigin, signal)
    let uploaded: Awaited<ReturnType<FileUploads['uploadStream']>>
    try {
      uploaded = await this.options.fileUploads.uploadStream({ sessionId, data, signal, name })
    } catch (error: unknown) {
      if (error instanceof Error && error.cause instanceof A2ABridgeError) throw error.cause
      throw error
    }
    return { type: 'file', receiptId: uploaded.receiptId }
  }

  /**
   * Store one remote raw or URL Part and resolve its provider-owned host path.
   * @param part - A2A file Part.
   * @param allowedOrigin - Exact-origin deployment policy.
   * @param signal - Caller cancellation.
   * @returns Stored file reference, media type, and absolute host path.
   */
  async materializePart(
    part: Part,
    allowedOrigin: (url: URL) => boolean,
    signal: AbortSignal,
  ): Promise<StoredA2AFile & { readonly path: string }> {
    const name = safeFileName(part.filename)
    const mediaType = mediaTypeOrDefault(part.mediaType)
    const data = await this.partBytes(part, allowedOrigin, signal)
    const ref = await this.options.attachments.saveFileStream({ data, signal, name })
    const path = this.options.attachments.fileHostPath(ref)
    if (path === undefined || !isAbsolute(path)) {
      throw new A2ABridgeError(
        'A2A_ATTACHMENT_PATH_UNAVAILABLE',
        'The mounted attachment provider cannot expose a local path for the received file.',
      )
    }
    return { ref, mediaType, path }
  }

  /**
   * Project one published attachment as inline bytes or a durable hosted URL.
   * @param file - Snapshotted file selected by the Agent.
   * @param taskId - Task owning a hosted capability when the file is large.
   * @param signal - Optional execution cancellation while reading inline bytes.
   * @returns A2A raw or URL Part.
   */
  async toPart(file: PublishedA2AFile, taskId: A2ATaskId, signal?: AbortSignal): Promise<Part> {
    if (file.ref.bytes > this.options.maxFileBytes) {
      throw new A2ABridgeError('A2A_FILE_TOO_LARGE', 'A2A file exceeds the configured byte limit.')
    }
    const filename = safeFileName(file.name)
    const mediaType = mediaTypeOrDefault(file.mediaType)
    if (file.ref.bytes <= this.options.inlineFileMaxBytes) {
      const chunks: Buffer[] = []
      for await (const chunk of boundedBytes(
        this.options.attachments.readFileStream(file.ref, signal),
        this.options.inlineFileMaxBytes,
        signal,
      )) chunks.push(Buffer.from(chunk))
      return {
        content: { $case: 'raw', value: Buffer.concat(chunks) },
        metadata: undefined,
        filename,
        mediaType,
      }
    }
    if (this.options.fileLinks === undefined) {
      throw new A2ABridgeError(
        'A2A_FILE_URL_UNAVAILABLE',
        'Large A2A files require a dedicated listener with hosted downloads enabled.',
      )
    }
    const url = await this.options.fileLinks.issue(file, taskId)
    return {
      content: { $case: 'url', value: url.href },
      metadata: undefined,
      filename,
      mediaType,
    }
  }

  private async partBytes(
    part: Part,
    allowedOrigin: (url: URL) => boolean,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    mediaTypeOrDefault(part.mediaType)
    const content = part.content
    if (content?.$case === 'raw') {
      const value = content.value
      return boundedBytes(singleChunk(value), this.options.maxFileBytes, signal)
    }
    if (content?.$case === 'url') {
      return this.fetchBytes(content.value, allowedOrigin, signal)
    }
    throw new A2ABridgeError('A2A_UNSUPPORTED_PART', 'A2A file transfer accepts only raw and URL Parts.')
  }

  private async fetchBytes(
    rawUrl: string,
    allowedOrigin: (url: URL) => boolean,
    callerSignal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    let current = validateFileUrl(rawUrl, allowedOrigin)
    let redirects = 0
    const timeoutSignal = AbortSignal.timeout(this.options.fetchTimeoutMs)
    const signal = AbortSignal.any([callerSignal, timeoutSignal])
    try {
      for (;;) {
        const response = await this.fetchImpl(current.href, { redirect: 'manual', signal })
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location')
          if (location === null) {
            return await responseBytes(
              response, this.options.maxFileBytes, signal, callerSignal, timeoutSignal,
            )
          }
          await cancelResponse(response)
          if (redirects >= this.options.maxRedirects) {
            throw new A2ABridgeError('A2A_FILE_REDIRECT_LIMIT', 'A2A file URI exceeded the redirect limit.')
          }
          const target = validateFileUrl(new URL(location, current).href, allowedOrigin)
          if (current.protocol === 'https:' && target.protocol === 'http:') {
            throw new A2ABridgeError('A2A_FILE_DOWNGRADE', 'A2A file URI cannot downgrade HTTPS to HTTP.')
          }
          current = target
          redirects += 1
          continue
        }
        if (!response.ok) {
          await cancelResponse(response)
          throw new A2ABridgeError('A2A_FILE_FETCH_FAILED', 'A2A file URI returned an unsuccessful response.')
        }
        return await responseBytes(response, this.options.maxFileBytes, signal, callerSignal, timeoutSignal)
      }
    } catch (error: unknown) {
      if (error instanceof A2ABridgeError) throw error
      if (timeoutSignal.aborted && !callerSignal.aborted) {
        throw new A2ABridgeError('A2A_FILE_FETCH_TIMEOUT', 'A2A file URI request timed out.', { cause: error })
      }
      if (callerSignal.aborted) throw aborted(error)
      throw new A2ABridgeError('A2A_FILE_FETCH_FAILED', 'A2A file URI request failed.', { cause: error })
    }
  }
}

async function *singleChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value
}

async function *readHandle(
  handle: Awaited<ReturnType<typeof open>>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  let position = 0
  for (;;) {
    signal.throwIfAborted()
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
    if (bytesRead === 0) return
    position += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

async function responseBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<AsyncIterable<Uint8Array>> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const bytes = Number(declared)
    if (Number.isFinite(bytes) && bytes > maximum) {
      await cancelResponse(response)
      throw new A2ABridgeError('A2A_FILE_TOO_LARGE', 'A2A file exceeds the configured byte limit.')
    }
  }
  if (response.body === null) return boundedBytes(singleChunk(new Uint8Array()), maximum, signal)
  return boundedBytes(readResponse(response, signal, callerSignal, timeoutSignal), maximum)
}

async function *readResponse(
  response: Response,
  signal: AbortSignal,
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const reader = response.body!.getReader()
  try {
    for (;;) {
      if (signal.aborted) throw fileFetchAbort(callerSignal, timeoutSignal, signal.reason)
      const { done, value } = await readWithSignal(reader, signal)
      if (done) return
      yield value
    }
  } catch (error: unknown) {
    if (signal.aborted) throw fileFetchAbort(callerSignal, timeoutSignal, error)
    throw error
  } finally {
    await reader.cancel().catch((_cancelError: unknown) => {
      // The transfer result owns the operation; cancellation only releases the response body.
    })
  }
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason
  return await new Promise((resolveRead, rejectRead) => {
    const onAbort = () => { rejectRead(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(resolveRead, rejectRead).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function validateFileUrl(raw: string, allowedOrigin: (url: URL) => boolean): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch (error: unknown) {
    throw new A2ABridgeError('A2A_FILE_URI_REJECTED', 'A2A file URI must be absolute HTTP(S).', { cause: error })
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== '' || url.hash !== '' || !allowedOrigin(url)) {
    throw new A2ABridgeError(
      'A2A_FILE_URI_REJECTED',
      'A2A file URI must use an allowed HTTP(S) origin without credentials or a fragment.',
    )
  }
  return url
}

function containsPath(root: string, target: string): boolean {
  const remainder = relative(root, target)
  return remainder === '' || (!remainder.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && remainder !== '..' && !isAbsolute(remainder))
}

function sameFile(before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>, after: typeof before): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch((_cancelError: unknown) => {
    // Redirect and rejection already own the result; cancellation only releases the response body.
  })
}

function pathRejected(cause?: unknown): A2ABridgeError {
  const message = 'A2A local file must resolve to a regular file inside the workspace or an allowed root.'
  return cause === undefined
    ? new A2ABridgeError('A2A_FILE_PATH_REJECTED', message)
    : new A2ABridgeError('A2A_FILE_PATH_REJECTED', message, { cause })
}

function aborted(cause: unknown): A2ABridgeError {
  return new A2ABridgeError('A2A_FILE_FETCH_ABORTED', 'A2A file transfer was canceled.', { cause })
}

function fileFetchAbort(
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  cause: unknown,
): A2ABridgeError {
  if (timeoutSignal.aborted && !callerSignal.aborted) {
    return new A2ABridgeError('A2A_FILE_FETCH_TIMEOUT', 'A2A file URI request timed out.', { cause })
  }
  return aborted(cause)
}
