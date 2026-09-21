import z from '@deepseek-ai/schemastery'
import { buildAgentCard } from './card.ts'
import type {
  A2AAgentConfig,
  A2ADeployment,
  A2ASkillConfig,
  Config as ConfigShape,
  ResolvedA2AConfig,
  ResolvedA2AConfigCore,
} from './types.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000
const DEFAULT_OUTBOUND_TIMEOUT_MS = 300_000
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_MAX_RESPONSE_BYTES = 4_194_304
const DEFAULT_MAX_CONCURRENT_CONTEXTS = 16
const MAX_TIMEOUT_MS = 1_800_000
const MAX_BODY_BYTES = 67_108_864
const MAX_CONCURRENT_CONTEXTS = 256

/** Cordis configuration schema for the A2A bridge. */
export const Config: z<ConfigShape> = z.object({
  route: z.string().default('/a2a'),
  publicBaseUrl: z.string(),
  agent: z.object({
    name: z.string().required(),
    description: z.string().required(),
    version: z.string().required(),
    defaultInputModes: z.array(z.string()).required(),
    defaultOutputModes: z.array(z.string()).required(),
    skills: z.array(z.object({
      id: z.string().required(),
      name: z.string().required(),
      description: z.string().required(),
      tags: z.array(z.string()).required(),
    })).required(),
  }).required(),
  bearerTokenEnv: z.string(),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_REQUEST_TIMEOUT_MS),
  outboundTimeoutMs: z.number().step(1).min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_OUTBOUND_TIMEOUT_MS),
  maxRequestBytes: z.number().step(1).min(1).max(MAX_BODY_BYTES).default(DEFAULT_MAX_REQUEST_BYTES),
  maxResponseBytes: z.number().step(1).min(1).max(MAX_BODY_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),
  maxConcurrentContexts: z.number().step(1).min(1).max(MAX_CONCURRENT_CONTEXTS).default(DEFAULT_MAX_CONCURRENT_CONTEXTS),
  agentPreset: z.string(),
})

function requiredText(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`business-a2a-bridge: ${field} must not be empty`)
  return normalized
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`business-a2a-bridge: ${field} must be an integer between 1 and ${maximum}`)
  }
  return resolved
}

function resolveRoute(value: string | undefined): string {
  const route = value ?? '/a2a'
  if (!route.startsWith('/') || route === '/' || route.includes('?') || route.includes('#')) {
    throw new Error('business-a2a-bridge: route must be an absolute non-root path without query or fragment')
  }
  return route.replace(/\/+$/, '')
}

function resolvePublicBaseUrl(value: string | undefined, deployment: A2ADeployment): URL {
  if (value === undefined && deployment.host === '0.0.0.0') {
    throw new Error('business-a2a-bridge: publicBaseUrl is required when listening on 0.0.0.0')
  }
  let url: URL
  try {
    url = new URL(value ?? `http://127.0.0.1:${deployment.port}`)
  } catch {
    throw new Error('business-a2a-bridge: publicBaseUrl must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('business-a2a-bridge: publicBaseUrl must use HTTP or HTTPS')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('business-a2a-bridge: publicBaseUrl must not contain credentials, query, or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return url
}

function resolveAgent(value: A2AAgentConfig): A2AAgentConfig {
  if (value.skills.length === 0) throw new Error('business-a2a-bridge: agent.skills must contain at least one skill')
  if (value.defaultInputModes.length === 0) throw new Error('business-a2a-bridge: agent.defaultInputModes must not be empty')
  if (value.defaultOutputModes.length === 0) throw new Error('business-a2a-bridge: agent.defaultOutputModes must not be empty')
  const modes = (items: readonly string[], field: string) => items.map((item, index) => requiredText(item, `${field}[${index}]`))
  const skills: A2ASkillConfig[] = value.skills.map((item, index) => ({
    id: requiredText(item.id, `agent.skills[${index}].id`),
    name: requiredText(item.name, `agent.skills[${index}].name`),
    description: requiredText(item.description, `agent.skills[${index}].description`),
    tags: modes(item.tags, `agent.skills[${index}].tags`),
  }))
  return {
    name: requiredText(value.name, 'agent.name'),
    description: requiredText(value.description, 'agent.description'),
    version: requiredText(value.version, 'agent.version'),
    defaultInputModes: modes(value.defaultInputModes, 'agent.defaultInputModes'),
    defaultOutputModes: modes(value.defaultOutputModes, 'agent.defaultOutputModes'),
    skills,
  }
}

function resolveBearerToken(config: ConfigShape, deployment: A2ADeployment): string | undefined {
  const envName = config.bearerTokenEnv?.trim()
  if (deployment.host === '0.0.0.0' && (envName === undefined || envName === '')) {
    throw new Error('business-a2a-bridge: bearerTokenEnv is required when listening on 0.0.0.0')
  }
  if (envName === undefined || envName === '') return undefined
  const token = deployment.env[envName]
  if (token === undefined || token.trim() === '') {
    throw new Error(`business-a2a-bridge: bearerTokenEnv ${envName} must reference a non-empty value`)
  }
  return token
}

/** Validate deployment policy and materialize the runtime configuration. */
export function resolveConfig(config: ConfigShape, deployment: A2ADeployment): ResolvedA2AConfig {
  const publicBaseUrl = resolvePublicBaseUrl(config.publicBaseUrl, deployment)
  const bearerToken = resolveBearerToken(config, deployment)
  const agentPreset = config.agentPreset === undefined ? undefined : requiredText(config.agentPreset, 'agentPreset')
  const core: ResolvedA2AConfigCore = {
    route: resolveRoute(config.route),
    cardPath: '/.well-known/agent-card.json',
    publicBaseUrl,
    ...(bearerToken === undefined ? {} : { bearerToken }),
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS, 'requestTimeoutMs'),
    outboundTimeoutMs: positiveInteger(config.outboundTimeoutMs, DEFAULT_OUTBOUND_TIMEOUT_MS, MAX_TIMEOUT_MS, 'outboundTimeoutMs'),
    maxRequestBytes: positiveInteger(config.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, MAX_BODY_BYTES, 'maxRequestBytes'),
    maxResponseBytes: positiveInteger(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_BODY_BYTES, 'maxResponseBytes'),
    maxConcurrentContexts: positiveInteger(config.maxConcurrentContexts, DEFAULT_MAX_CONCURRENT_CONTEXTS, MAX_CONCURRENT_CONTEXTS, 'maxConcurrentContexts'),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    agent: resolveAgent(config.agent),
  }
  return { ...core, agentCard: buildAgentCard(core) }
}
