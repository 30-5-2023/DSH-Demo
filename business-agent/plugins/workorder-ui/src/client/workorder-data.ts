/** Activity states exposed by the MVP work-order service. */
export type WorkorderActivityStatus = 'pending' | 'running' | 'waiting' | 'done'

/** Order states exposed by the MVP work-order service. */
export type WorkorderStatus = 'ready' | 'running' | 'waiting' | 'done'

/** Display metadata for an activity input or output. */
export interface WorkorderResource {
  readonly resourceId: string
  readonly name: string
  readonly kind?: string
  readonly fromActivitySeq?: number
}

/** One ordered activity in a work-order snapshot. */
export interface WorkorderActivity {
  readonly id: string
  readonly seq: number
  readonly title: string
  readonly type: string
  readonly automation: string
  readonly status: WorkorderActivityStatus
  readonly needsHuman: boolean
  readonly interactionId: string | null
  readonly inputs: readonly WorkorderResource[]
  readonly outputs: readonly WorkorderResource[]
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

/** Authoritative service snapshot consumed by the Sidebar. */
export interface WorkorderSnapshot {
  readonly rev: number
  readonly order: {
    readonly id: string
    readonly title: string
    readonly status: WorkorderStatus
    readonly owner: string
    readonly currentActivitySeq: number
    readonly activities: readonly WorkorderActivity[]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`invalid ${key}`)
  return value
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value !== null && typeof value !== 'string') throw new Error(`invalid ${key}`)
  return value
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid ${key}`)
  return value as number
}

function resource(value: unknown): WorkorderResource {
  if (!isRecord(value)) throw new Error('invalid resource')
  const kind = value.kind
  const fromActivitySeq = value.fromActivitySeq
  if (kind !== undefined && typeof kind !== 'string') throw new Error('invalid resource kind')
  if (fromActivitySeq !== undefined && !Number.isSafeInteger(fromActivitySeq)) throw new Error('invalid source activity')
  return {
    resourceId: stringField(value, 'resourceId'),
    name: stringField(value, 'name'),
    ...(kind === undefined ? {} : { kind }),
    ...(fromActivitySeq === undefined ? {} : { fromActivitySeq: fromActivitySeq as number }),
  }
}

function resources(record: Record<string, unknown>, key: string): readonly WorkorderResource[] {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`invalid ${key}`)
  return value.map(resource)
}

function activity(value: unknown): WorkorderActivity {
  if (!isRecord(value)) throw new Error('invalid activity')
  const status = stringField(value, 'status')
  if (!['pending', 'running', 'waiting', 'done'].includes(status)) throw new Error('invalid activity status')
  if (typeof value.needsHuman !== 'boolean') throw new Error('invalid needsHuman')
  return {
    id: stringField(value, 'id'),
    seq: numberField(value, 'seq'),
    title: stringField(value, 'title'),
    type: stringField(value, 'type'),
    automation: stringField(value, 'automation'),
    status: status as WorkorderActivityStatus,
    needsHuman: value.needsHuman,
    interactionId: nullableStringField(value, 'interactionId'),
    inputs: resources(value, 'inputs'),
    outputs: resources(value, 'outputs'),
    startedAt: nullableStringField(value, 'startedAt'),
    finishedAt: nullableStringField(value, 'finishedAt'),
  }
}

/**
 * Validate an order snapshot received at the browser HTTP boundary.
 * @param value Parsed JSON value.
 * @returns Validated work-order snapshot.
 * @throws When a required field is missing or invalid.
 */
export function parseOrderSnapshot(value: unknown): WorkorderSnapshot {
  if (!isRecord(value) || !isRecord(value.order)) throw new Error('invalid snapshot')
  const rev = numberField(value, 'rev')
  const order = value.order
  const status = stringField(order, 'status')
  if (!['ready', 'running', 'waiting', 'done'].includes(status)) throw new Error('invalid order status')
  if (!Array.isArray(order.activities)) throw new Error('invalid activities')
  return {
    rev,
    order: {
      id: stringField(order, 'id'),
      title: stringField(order, 'title'),
      status: status as WorkorderStatus,
      owner: stringField(order, 'owner'),
      currentActivitySeq: numberField(order, 'currentActivitySeq'),
      activities: order.activities.map(activity).sort((left, right) => left.seq - right.seq),
    },
  }
}

/**
 * Read the monotonic revision from an SSE data frame.
 * @param data Raw SSE `data` payload.
 * @returns Revision when valid, otherwise `undefined`.
 */
export function parseEventRevision(data: string): number | undefined {
  try {
    const value: unknown = JSON.parse(data)
    if (!isRecord(value) || !Number.isSafeInteger(value.rev) || (value.rev as number) < 0) return undefined
    return value.rev as number
  } catch {
    return undefined
  }
}
