import { randomBytes } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
} from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  A2AFileToken,
  A2ATaskId,
  type A2AFileLinkRecord,
  type A2AFileLinkRepository,
  type StoredA2AFile,
} from './types.ts'

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

interface StoredA2AFileLinkRecord {
  readonly token: string
  readonly taskId: string
  readonly ref: {
    readonly attachmentId: string
    readonly name: string
    readonly bytes: number
  }
  readonly mediaType: string
  readonly createdAt: string
  readonly expiresAt: string
}

const fileLinkRecordSchema: z.ZodType<StoredA2AFileLinkRecord> = z.object({
  token: z.string().regex(TOKEN),
  taskId: z.string().min(1),
  ref: z.object({
    attachmentId: z.string().min(1),
    name: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  }),
  mediaType: z.string().regex(MEDIA_TYPE),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
})

/** Independent version-one durable domain for hosted A2A file capabilities. */
export const a2aBridgeFileLinksDomain = defineDomain({
  name: 'a2a_bridge_file_links',
  version: 1,
  tables: {
    links: domainTable<A2AFileToken, StoredA2AFileLinkRecord>(fileLinkRecordSchema),
  },
})

/** Storage-domain implementation of hosted A2A file-link metadata. */
export class StorageDomainA2AFileLinkRepository implements A2AFileLinkRepository {
  private closed = false

  private constructor(private readonly domain: Domain<typeof a2aBridgeFileLinksDomain>) {}

  /** Open the independent file-link metadata domain through the configured backend. */
  static async open(facility: DomainFacility): Promise<StorageDomainA2AFileLinkRepository> {
    return new StorageDomainA2AFileLinkRepository(await facility.open(a2aBridgeFileLinksDomain))
  }

  async put(record: A2AFileLinkRecord): Promise<void> {
    this.assertOpen()
    const encoded = encodeRecord(record)
    fileLinkRecordSchema.parse(encoded)
    await this.domain.table('links').put(record.token, encoded)
  }

  async get(token: A2AFileToken): Promise<A2AFileLinkRecord | undefined> {
    this.assertOpen()
    const record = this.domain.table('links').get(token)
    return record === undefined ? undefined : decodeRecord(record)
  }

  async delete(token: A2AFileToken): Promise<void> {
    this.assertOpen()
    await this.domain.table('links').delete(token)
  }

  async reapExpired(now: string): Promise<number> {
    this.assertOpen()
    const cutoff = Date.parse(now)
    if (!Number.isFinite(cutoff)) throw new Error('business-a2a-bridge: file-link reap time must be an ISO timestamp')
    const table = this.domain.table('links')
    let removed = 0
    for (const [token, record] of table.entries()) {
      if (Date.parse(record.expiresAt) > cutoff) continue
      if (await table.delete(token)) removed += 1
    }
    return removed
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.domain.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('business-a2a-bridge: file-link repository is closed')
  }
}

/** Deployment-owned URL and expiry policy for hosted A2A file links. */
export interface A2AFileLinksOptions {
  readonly publicBaseUrl: URL
  readonly route: string
  readonly retentionMs: number
  readonly now?: () => Date
}

/** Resolution state for one opaque hosted-file capability. */
export type A2AFileLinkResolution =
  | { readonly kind: 'found'; readonly record: A2AFileLinkRecord }
  | { readonly kind: 'expired' }
  | { readonly kind: 'missing' }

/** Issue and resolve opaque, durable, expiring hosted-file capabilities. */
export class A2AFileLinks {
  private readonly now: () => Date
  private issueTail: Promise<void> = Promise.resolve()

  /**
   * @param repository - Durable file-link metadata store.
   * @param options - Public URL, route, lifetime, and optional clock.
   */
  constructor(
    private readonly repository: A2AFileLinkRepository,
    private readonly options: A2AFileLinksOptions,
  ) {
    if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs < 1) {
      throw new TypeError('business-a2a-bridge: file link retentionMs must be a positive integer')
    }
    this.now = options.now ?? (() => new Date())
  }

  /** Delete every record expired at the current clock value. */
  reapExpired(): Promise<number> {
    return this.repository.reapExpired(this.currentTime().toISOString())
  }

  /**
   * Persist a fresh capability before exposing its URL.
   * @param file - Immutable attachment and media type to publish.
   * @param taskId - Owning A2A Task.
   * @returns Reachable hosted-file URL.
   */
  issue(file: StoredA2AFile, taskId: A2ATaskId): Promise<URL> {
    return this.serializeIssue(async () => {
      const created = this.currentTime()
      await this.repository.reapExpired(created.toISOString())
      let token: A2AFileToken
      do {
        token = A2AFileToken(randomBytes(32).toString('base64url'))
      } while (await this.repository.get(token) !== undefined)
      const record: A2AFileLinkRecord = {
        token,
        taskId,
        ref: file.ref,
        mediaType: file.mediaType,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + this.options.retentionMs).toISOString(),
      }
      await this.repository.put(record)
      return new URL(`${this.options.route}/files/${token}`, this.options.publicBaseUrl)
    })
  }

  /**
   * Resolve one capability and revoke it when its lifetime has elapsed.
   * @param rawToken - Untrusted URL path segment.
   * @returns Found metadata, expired state, or missing state.
   */
  async resolve(rawToken: string): Promise<A2AFileLinkResolution> {
    if (!TOKEN.test(rawToken)) return { kind: 'missing' }
    const token = A2AFileToken(rawToken)
    const record = await this.repository.get(token)
    if (record === undefined) return { kind: 'missing' }
    if (Date.parse(record.expiresAt) <= this.currentTime().getTime()) {
      await this.repository.delete(token)
      return { kind: 'expired' }
    }
    return { kind: 'found', record }
  }

  private serializeIssue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.issueTail.then(operation)
    this.issueTail = result.then(() => {}, () => {})
    return result
  }

  private currentTime(): Date {
    const value = this.now()
    if (!Number.isFinite(value.getTime())) throw new Error('business-a2a-bridge: file link clock returned an invalid Date')
    return value
  }
}

function encodeRecord(record: A2AFileLinkRecord): StoredA2AFileLinkRecord {
  return {
    token: record.token,
    taskId: record.taskId,
    ref: {
      attachmentId: record.ref.attachmentId,
      name: record.ref.name,
      bytes: record.ref.bytes,
    },
    mediaType: record.mediaType,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  }
}

function decodeRecord(record: StoredA2AFileLinkRecord): A2AFileLinkRecord {
  return {
    token: A2AFileToken(record.token),
    taskId: A2ATaskId(record.taskId),
    ref: {
      attachmentId: AttachmentId(record.ref.attachmentId),
      name: record.ref.name,
      bytes: record.ref.bytes,
    },
    mediaType: record.mediaType,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  }
}
