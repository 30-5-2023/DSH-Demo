import type { AgentCard } from '@a2a-js/sdk'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable A2A context identity owned by the bridge. */
export type A2AContextId = Branded<'A2AContextId'>
/** Stable A2A task identity owned by the bridge. */
export type A2ATaskId = Branded<'A2ATaskId'>
/** Caller-provided A2A message identity used for idempotency. */
export type A2AMessageId = Branded<'A2AMessageId'>

/** One skill declared by the configured Business Agent. */
export interface A2ASkillConfig {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: string[]
}

/** Public identity and media declarations for the configured Business Agent. */
export interface A2AAgentConfig {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly defaultInputModes: string[]
  readonly defaultOutputModes: string[]
  readonly skills: A2ASkillConfig[]
}

/** User-facing Cordis plugin configuration. */
export interface Config {
  readonly route?: string
  readonly publicBaseUrl?: string
  readonly agent: A2AAgentConfig
  readonly bearerTokenEnv?: string
  readonly requestTimeoutMs?: number
  readonly outboundTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxConcurrentContexts?: number
  readonly agentPreset?: string
}

/** Validated runtime configuration before the Agent Card is materialized. */
export interface ResolvedA2AConfigCore {
  readonly route: string
  readonly cardPath: '/.well-known/agent-card.json'
  readonly publicBaseUrl: URL
  readonly bearerToken?: string
  readonly requestTimeoutMs: number
  readonly outboundTimeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly maxConcurrentContexts: number
  readonly agentPreset?: string
  readonly agent: A2AAgentConfig
}

/** Fully validated configuration consumed by all bridge components. */
export interface ResolvedA2AConfig extends ResolvedA2AConfigCore {
  readonly agentCard: AgentCard
}

/** Web Server deployment facts required to validate public endpoint policy. */
export interface A2ADeployment {
  readonly host: string
  readonly port: number
  readonly env: NodeJS.ProcessEnv
}
