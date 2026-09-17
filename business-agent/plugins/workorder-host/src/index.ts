import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'business-workorder-host'
/** Required service for top-level tool-result observation. */
export const inject = ['tools']

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

function orderIdFrom(argumentsValue: unknown): OrderId {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) {
    throw new Error('business-workorder-host: successful work-order tool call carried non-object arguments')
  }
  const orderId = (argumentsValue as Record<string, unknown>).orderId
  if (typeof orderId !== 'string' || orderId.trim() === '' || orderId.length > 256) {
    throw new Error('business-workorder-host: successful work-order tool call carried an invalid orderId')
  }
  return orderId as OrderId
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
  return { agent: exec.agent, orderId: orderIdFrom(exec.arguments), toolName: exec.name }
}

/** Process-local primary Agent and recency index for work orders. */
export class WorkorderBindings {
  private readonly primaryByOrder = new Map<OrderId, Agent>()
  private readonly ordersByAgent = new WeakMap<Agent, Map<OrderId, number>>()
  private sequence = 0

  /**
   * Record a successful call without silently moving another Agent's primary binding.
   * @param candidate Validated binding candidate.
   */
  bind(candidate: WorkorderBindingCandidate): void {
    const primary = this.primaryByOrder.get(candidate.orderId)
    if (primary !== undefined && primary !== candidate.agent) return
    this.primaryByOrder.set(candidate.orderId, candidate.agent)
    const orders = this.ordersByAgent.get(candidate.agent) ?? new Map<OrderId, number>()
    orders.set(candidate.orderId, ++this.sequence)
    this.ordersByAgent.set(candidate.agent, orders)
  }

  /**
   * Read an order's primary Agent.
   * @param orderId Opaque order identifier.
   * @returns Bound Agent, if one exists.
   */
  primary(orderId: OrderId): Agent | undefined {
    return this.primaryByOrder.get(orderId)
  }

  /**
   * Read one Agent's bound order ids, most recently active first.
   * @param agent Agent identity.
   * @returns Stable order-id snapshot.
   */
  orders(agent: Agent): readonly OrderId[] {
    return [...(this.ordersByAgent.get(agent)?.entries() ?? [])]
      .sort((left, right) => right[1] - left[1])
      .map(([orderId]) => orderId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Process-local work-order bindings owned by the business Host plugin. */
    businessWorkorders: WorkorderBindings
  }
}

/**
 * Observe successful top-level native work-order tools and record their Agent binding.
 * @param ctx Cordis context carrying the Tool runtime.
 */
export function apply(ctx: Context): void {
  const bindings = new WorkorderBindings()
  ctx.provide('businessWorkorders', bindings)
  ctx.on('tools/result', (exec, result) => {
    const candidate = bindingCandidate(exec, result)
    if (candidate !== undefined) bindings.bind(candidate)
  })
}
