import type { AgentCard, AgentSkill, SecurityRequirement, SecurityScheme } from '@a2a-js/sdk'
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3'
import type { ResolvedA2AConfigCore } from './types.ts'

const BEARER_SCHEME: SecurityScheme = {
  scheme: {
    $case: 'httpAuthSecurityScheme',
    value: {
      description: 'Bearer token for the A2A JSON-RPC endpoint.',
      scheme: 'Bearer',
      bearerFormat: '',
    },
  },
}

const BEARER_REQUIREMENT: SecurityRequirement = {
  schemes: { bearer: { list: [] } },
}

function skill(config: ResolvedA2AConfigCore, value: ResolvedA2AConfigCore['agent']['skills'][number]): AgentSkill {
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    tags: [...value.tags],
    examples: [],
    inputModes: [...config.agent.defaultInputModes],
    outputModes: [...config.agent.defaultOutputModes],
    securityRequirements: config.bearerToken === undefined ? [] : [BEARER_REQUIREMENT],
  }
}

/** Build the A2A v1.0 Agent Card with its v0.3 JSON-RPC compatibility interface. */
export function buildAgentCard(config: ResolvedA2AConfigCore): AgentCard {
  const rpcUrl = new URL(config.route, config.publicBaseUrl)
  const supportedInterfaces = duplicateInterfacesForLegacy([{
    url: rpcUrl.href,
    protocolBinding: 'JSONRPC',
    tenant: '',
    protocolVersion: '1.0',
  }], ['JSONRPC'])
  return {
    name: config.agent.name,
    description: config.agent.description,
    supportedInterfaces,
    provider: undefined,
    version: config.agent.version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: config.bearerToken === undefined ? {} : { bearer: BEARER_SCHEME },
    securityRequirements: config.bearerToken === undefined ? [] : [BEARER_REQUIREMENT],
    defaultInputModes: [...config.agent.defaultInputModes],
    defaultOutputModes: [...config.agent.defaultOutputModes],
    skills: config.agent.skills.map(value => skill(config, value)),
    signatures: [],
  }
}
