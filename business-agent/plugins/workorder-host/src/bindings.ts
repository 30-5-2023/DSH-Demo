import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

declare const orderIdBrand: unique symbol
/** Opaque identifier owned by the business work-order service. */
export type OrderId = string & { readonly [orderIdBrand]: true }

/** Successful top-level work-order tool call used to establish a binding. */
export interface WorkorderBindingCandidate {
  /** Calling Agent whose Session owns the binding. */
  readonly agent: Agent
  /** Opaque business order identifier from validated tool JSON. */
  readonly orderId: OrderId
  /** Qualified native tool name that established or refreshed the binding. */
  readonly toolName: string
}

const WORKORDER_TOOLS = new Set([
  'mcp__workorder__get_order',
  'mcp__workorder__start_order',
  'mcp__workorder__start_activity',
  'mcp__workorder__finish_activity',
])

/**
 * Validate one order id at an external tool or event boundary.
 * @param value Candidate identifier.
 * @returns Branded non-empty order id.
 */
export function OrderId(value: unknown): OrderId {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
    throw new Error('business-workorder-host: expected a non-empty orderId of at most 256 characters')
  }
  return value as OrderId
}

/**
 * Select successful native top-level work-order calls that can establish bindings.
 * @param exec Frozen tool execution.
 * @param result Frozen final tool result.
 * @returns Binding candidate, or undefined for calls outside this ownership rule.
 */
export function bindingCandidate(
  exec: Readonly<ToolExecution>,
  result: Readonly<ToolExecutionResult>,
): WorkorderBindingCandidate | undefined {
  if (result.isError || exec.agent === undefined || exec.parent !== undefined || !WORKORDER_TOOLS.has(exec.name)) {
    return undefined
  }
  if (typeof exec.arguments !== 'object' || exec.arguments === null || Array.isArray(exec.arguments)) {
    throw new Error('business-workorder-host: successful work-order tool call carried non-object arguments')
  }
  return {
    agent: exec.agent,
    orderId: OrderId((exec.arguments as Record<string, unknown>).orderId),
    toolName: exec.name,
  }
}

/** Process-local primary Session and recency index for work orders. */
export class WorkorderBindings {
  private readonly primaryByOrder = new Map<OrderId, SessionId>()
  private readonly ordersBySession = new Map<SessionId, Map<OrderId, number>>()
  private readonly liveAgents = new Map<SessionId, Agent>()
  private sequence = 0

  /**
   * Record a successful call without silently moving another Session's primary binding.
   * @param candidate Validated binding candidate.
   * @returns Whether this call established or refreshed the primary binding.
   */
  bind(candidate: WorkorderBindingCandidate): boolean {
    const sessionId = candidate.agent.id
    const primary = this.primaryByOrder.get(candidate.orderId)
    if (primary !== undefined && primary !== sessionId) return false
    this.primaryByOrder.set(candidate.orderId, sessionId)
    this.liveAgents.set(sessionId, candidate.agent)
    const orders = this.ordersBySession.get(sessionId) ?? new Map<OrderId, number>()
    orders.set(candidate.orderId, ++this.sequence)
    this.ordersBySession.set(sessionId, orders)
    return true
  }

  /**
   * Replace a stale process-local Agent reference for an already-bound Session.
   * @param agent Newly live Agent.
   */
  agentCreated(agent: Agent): void {
    if (this.ordersBySession.has(agent.id)) this.liveAgents.set(agent.id, agent)
  }

  /**
   * Forget a disposed Agent without deleting its pending Session bindings.
   * @param agent Agent leaving the live registry.
   */
  agentDisposed(agent: Agent): void {
    if (this.liveAgents.get(agent.id) === agent) this.liveAgents.delete(agent.id)
  }

  /**
   * Read an order's primary Session id.
   * @param orderId Opaque order identifier.
   * @returns Bound Session id, if one exists.
   */
  primarySession(orderId: OrderId): SessionId | undefined {
    return this.primaryByOrder.get(orderId)
  }

  /**
   * Read the latest known live Agent reference for an order.
   * @param orderId Opaque order identifier.
   * @returns Bound Agent, if its exact process-local instance is live.
   */
  primary(orderId: OrderId): Agent | undefined {
    const sessionId = this.primarySession(orderId)
    return sessionId === undefined ? undefined : this.liveAgents.get(sessionId)
  }

  /**
   * Read one Session's bound order ids, most recently active first.
   * @param agent Agent or Session identity.
   * @returns Stable order-id snapshot.
   */
  orders(agent: Agent | SessionId): readonly OrderId[] {
    const sessionId = typeof agent === 'string' ? agent : agent.id
    return [...(this.ordersBySession.get(sessionId)?.entries() ?? [])]
      .sort((left, right) => right[1] - left[1])
      .map(([orderId]) => orderId)
  }
}
