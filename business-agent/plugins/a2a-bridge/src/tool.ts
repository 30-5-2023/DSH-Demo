import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { A2AAgentClient } from './client.ts'
import type { CallA2AAgentInput, CallA2AAgentResult } from './types.ts'

/** Define the URL-only model-facing tool for invoking another A2A agent. */
export function createCallA2AAgentTool(
  client: Pick<A2AAgentClient, 'call'>,
  maxTimeoutMs: number,
): ToolDefinition {
  return defineTool({
    name: 'call_a2a_agent',
    description: 'Call an A2A v1.0 agent by its Agent Card URL. Pass context_id from an earlier result to continue that remote conversation. Outbound authentication is not supported.',
    parameters: {
      agent_card_url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL of the remote Agent Card.' },
      message: { type: 'json', required: true, description: 'Text or JSON value to send to the remote agent.' },
      context_id: { type: 'string', description: 'Remote context identifier returned by an earlier call.' },
      stream: { type: 'boolean', description: 'Use streaming updates; defaults to true.' },
      accepted_output_mode: { type: 'string', enum: ['text', 'json'], description: 'Expected output mode; defaults to text.' },
      timeout_ms: { type: 'integer', description: `Per-call timeout in milliseconds, capped at ${maxTimeoutMs}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          context_id: { type: 'string' },
          task_id: { type: 'string' },
          state: { type: 'string', required: true },
          output: { type: 'json' },
          failure: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec): Promise<CallA2AAgentResult> {
      const timeout = args.timeout_ms === undefined
        ? undefined
        : Math.max(1, Math.min(args.timeout_ms, maxTimeoutMs))
      const input: CallA2AAgentInput = {
        agent_card_url: args.agent_card_url,
        message: args.message,
        ...(args.context_id === undefined ? {} : { context_id: args.context_id }),
        ...(args.stream === undefined ? {} : { stream: args.stream }),
        ...(args.accepted_output_mode === undefined ? {} : { accepted_output_mode: args.accepted_output_mode }),
        ...(timeout === undefined ? {} : { timeout_ms: timeout }),
      }
      return await client.call(input, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'call_a2a_agent', rawInput: args.agent_card_url }),
    presentResult: () => ({ card: 'generic' }),
  })
}
