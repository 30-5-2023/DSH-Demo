import { isAbsolute, resolve as resolvePath } from 'node:path'
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
const DEFAULT_MAX_REQUEST_BYTES = 2_097_152
const DEFAULT_MAX_RESPONSE_BYTES = 4_194_304
const DEFAULT_MAX_CONCURRENT_CONTEXTS = 16
const DEFAULT_INLINE_FILE_MAX_BYTES = 1_048_576
const DEFAULT_MAX_FILE_BYTES = 268_435_456
const DEFAULT_FILE_RETENTION_MS = 86_400_000
const MAX_TIMEOUT_MS = 1_800_000
const MAX_BODY_BYTES = 67_108_864
const MAX_CONCURRENT_CONTEXTS = 256
const MAX_FILE_BYTES = 4_294_967_296
const MIN_FILE_RETENTION_MS = 60_000
const MAX_FILE_RETENTION_MS = 2_592_000_000
const INLINE_JSON_OVERHEAD_BYTES = 65_536

/** Cordis configuration schema for the A2A bridge. */
export const Config: z<ConfigShape> = z.object({
  route: z.string().default('/a2a'),
  listener: z.union([z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.number().step(1).min(1).max(65_535).required(),
  }), z.const(undefined)]),
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
  inlineFileMaxBytes: z.number().step(1).min(1).max(MAX_FILE_BYTES).default(DEFAULT_INLINE_FILE_MAX_BYTES),
  maxFileBytes: z.number().step(1).min(1).max(MAX_FILE_BYTES).default(DEFAULT_MAX_FILE_BYTES),
  fileRetentionMs: z.number().step(1).min(MIN_FILE_RETENTION_MS).max(MAX_FILE_RETENTION_MS).default(DEFAULT_FILE_RETENTION_MS),
  fileUrlAllowedOrigins: z.array(z.string()).default([]),
  publishFileAllowedRoots: z.array(z.string()).default([]),
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

function resolveListener(config: ConfigShape): ConfigShape['listener'] {
  if (config.listener === undefined) return undefined
  if (config.listener.host !== '127.0.0.1' && config.listener.host !== '0.0.0.0') {
    throw new Error('business-a2a-bridge: listener.host must be 127.0.0.1 or 0.0.0.0')
  }
  return {
    host: config.listener.host,
    port: positiveInteger(config.listener.port, config.listener.port, 65_535, 'listener.port'),
  }
}

function resolvePublicBaseUrl(value: string | undefined, host: string, port: number): URL {
  if (value === undefined && host === '0.0.0.0') {
    throw new Error('business-a2a-bridge: publicBaseUrl is required when listening on 0.0.0.0')
  }
  let url: URL
  try {
    url = new URL(value ?? `http://127.0.0.1:${port}`)
  } catch {
    throw new Error('business-a2a-bridge: publicBaseUrl must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('business-a2a-bridge: publicBaseUrl must use HTTP or HTTPS')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('business-a2a-bridge: publicBaseUrl must not contain credentials, query, or fragment')
  }
  if (url.hostname === '0.0.0.0') {
    throw new Error('business-a2a-bridge: publicBaseUrl must not advertise 0.0.0.0')
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
  const withFileMode = (items: string[]) => items.includes('application/octet-stream')
    ? items
    : [...items, 'application/octet-stream']
  return {
    name: requiredText(value.name, 'agent.name'),
    description: requiredText(value.description, 'agent.description'),
    version: requiredText(value.version, 'agent.version'),
    defaultInputModes: withFileMode(modes(value.defaultInputModes, 'agent.defaultInputModes')),
    defaultOutputModes: withFileMode(modes(value.defaultOutputModes, 'agent.defaultOutputModes')),
    skills,
  }
}

function resolveFileOrigins(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value, index) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`business-a2a-bridge: fileUrlAllowedOrigins[${index}] must be an absolute HTTP(S) origin`)
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== '' || url.password !== '' || url.pathname !== '/'
      || url.search !== '' || url.hash !== '') {
      throw new Error(`business-a2a-bridge: fileUrlAllowedOrigins[${index}] must be an exact HTTP(S) origin`)
    }
    return url.origin
  }))]
}

function resolveAllowedRoots(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value, index) => {
    if (!isAbsolute(value)) {
      throw new Error(`business-a2a-bridge: publishFileAllowedRoots[${index}] must be an absolute path`)
    }
    return resolvePath(value)
  }))]
}

function resolveBearerToken(config: ConfigShape, deployment: A2ADeployment): string | undefined {
  const envName = config.bearerTokenEnv?.trim()
  if (envName === undefined || envName === '') return undefined
  const token = deployment.env[envName]
  if (token === undefined || token.trim() === '') {
    throw new Error(`business-a2a-bridge: bearerTokenEnv ${envName} must reference a non-empty value`)
  }
  return token
}

/** Validate deployment policy and materialize the runtime configuration. */
export function resolveConfig(config: ConfigShape, deployment: A2ADeployment): ResolvedA2AConfig {
  const listener = resolveListener(config)
  const effectiveHost = listener?.host ?? deployment.host
  const effectivePort = listener?.port ?? deployment.port
  const publicBaseUrl = resolvePublicBaseUrl(config.publicBaseUrl, effectiveHost, effectivePort)
  const bearerToken = resolveBearerToken(config, deployment)
  const agentPreset = config.agentPreset === undefined ? undefined : requiredText(config.agentPreset, 'agentPreset')
  const inlineFileMaxBytes = positiveInteger(
    config.inlineFileMaxBytes, DEFAULT_INLINE_FILE_MAX_BYTES, MAX_FILE_BYTES, 'inlineFileMaxBytes',
  )
  const maxFileBytes = positiveInteger(config.maxFileBytes, DEFAULT_MAX_FILE_BYTES, MAX_FILE_BYTES, 'maxFileBytes')
  if (inlineFileMaxBytes > maxFileBytes) {
    throw new Error('business-a2a-bridge: inlineFileMaxBytes must not exceed maxFileBytes')
  }
  const maxRequestBytes = positiveInteger(config.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, MAX_BODY_BYTES, 'maxRequestBytes')
  const requiredInlineBodyBytes = 4 * Math.ceil(inlineFileMaxBytes / 3) + INLINE_JSON_OVERHEAD_BYTES
  if (maxRequestBytes < requiredInlineBodyBytes) {
    throw new Error('business-a2a-bridge: maxRequestBytes must accommodate inlineFileMaxBytes after base64 and JSON overhead')
  }
  const fileRetentionMs = positiveInteger(
    config.fileRetentionMs, DEFAULT_FILE_RETENTION_MS, MAX_FILE_RETENTION_MS, 'fileRetentionMs',
  )
  if (fileRetentionMs < MIN_FILE_RETENTION_MS) {
    throw new Error(`business-a2a-bridge: fileRetentionMs must be at least ${MIN_FILE_RETENTION_MS}`)
  }
  const core: ResolvedA2AConfigCore = {
    route: resolveRoute(config.route),
    cardPath: '/.well-known/agent-card.json',
    ...(listener === undefined ? {} : { listener }),
    publicBaseUrl,
    ...(bearerToken === undefined ? {} : { bearerToken }),
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS, 'requestTimeoutMs'),
    outboundTimeoutMs: positiveInteger(config.outboundTimeoutMs, DEFAULT_OUTBOUND_TIMEOUT_MS, MAX_TIMEOUT_MS, 'outboundTimeoutMs'),
    maxRequestBytes,
    maxResponseBytes: positiveInteger(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_BODY_BYTES, 'maxResponseBytes'),
    maxConcurrentContexts: positiveInteger(config.maxConcurrentContexts, DEFAULT_MAX_CONCURRENT_CONTEXTS, MAX_CONCURRENT_CONTEXTS, 'maxConcurrentContexts'),
    inlineFileMaxBytes,
    maxFileBytes,
    fileRetentionMs,
    fileUrlAllowedOrigins: resolveFileOrigins(config.fileUrlAllowedOrigins),
    publishFileAllowedRoots: resolveAllowedRoots(config.publishFileAllowedRoots),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    agent: resolveAgent(config.agent),
  }
  return { ...core, agentCard: buildAgentCard(core) }
}
