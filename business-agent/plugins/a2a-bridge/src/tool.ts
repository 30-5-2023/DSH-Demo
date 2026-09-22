import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { A2AAgentClient } from './client.ts'
import type { A2AFileTransfer } from './file-transfer.ts'
import { safeFileName } from './file-transfer.ts'
import type { A2AFilePublications } from './publication.ts'
import { A2ABridgeError, type CallA2AAgentInput, type CallA2AAgentResult } from './types.ts'

/** Define the model-facing tool for invoking another A2A agent with optional local files. */
export function createCallA2AAgentTool(
  client: Pick<A2AAgentClient, 'call'>,
  maxTimeoutMs: number,
): ToolDefinition {
  return defineTool({
    name: 'call_a2a_agent',
    description: 'Call an A2A agent by its Agent Card URL. Local files are resolved from the current Session workspace. Pass context_id from an earlier result to continue that remote conversation. Outbound authentication is not supported.',
    parameters: {
      agent_card_url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL of the remote Agent Card.' },
      message: { type: 'json', required: true, description: 'Text or JSON value to send to the remote agent.' },
      files: {
        type: 'array',
        description: 'Optional local files sent after the message Part, in this order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Workspace-relative or deployment-allowed absolute file path.' },
            name: { type: 'string', description: 'Optional safe display filename.' },
            mime_type: { type: 'string', description: 'Optional MIME type; defaults to application/octet-stream.' },
          },
        },
      },
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
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                name: { type: 'string', required: true },
                mime_type: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                artifact_id: { type: 'string', required: true },
              },
            },
          },
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
        ...(args.files === undefined ? {} : { files: args.files }),
        ...(args.context_id === undefined ? {} : { context_id: args.context_id }),
        ...(args.stream === undefined ? {} : { stream: args.stream }),
        ...(args.accepted_output_mode === undefined ? {} : { accepted_output_mode: args.accepted_output_mode }),
        ...(timeout === undefined ? {} : { timeout_ms: timeout }),
      }
      return await client.call(input, exec.signal, exec.agent?.session.header.cwd)
    },
    presentCall: args => ({ card: 'generic', title: 'call_a2a_agent', rawInput: args.agent_card_url }),
    presentResult: () => ({ card: 'generic' }),
  })
}

/** Define the Session-scoped tool that publishes one local file into the completing A2A Task. */
export function createPublishA2AFileTool(
  publications: Pick<A2AFilePublications, 'assertActive' | 'publish'>,
  transfer: Pick<A2AFileTransfer, 'snapshotLocal'>,
): ToolDefinition {
  return defineTool({
    name: 'publish_a2a_file',
    description: 'Publish one local file as an output of the active inbound A2A task. The path is resolved from the current Session workspace.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative or deployment-allowed absolute file path.' },
      name: { type: 'string', description: 'Optional safe display filename.' },
      mime_type: { type: 'string', description: 'Optional MIME type; defaults to application/octet-stream.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          mime_type: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          attachment_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new A2ABridgeError(
          'A2A_PUBLICATION_AGENT_REQUIRED',
          'publish_a2a_file requires an Agent-backed Session.',
        )
      }
      const sessionId = agent.session.header.id
      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        throw new A2ABridgeError(
          'A2A_PUBLICATION_WORKSPACE_REQUIRED',
          'publish_a2a_file requires a Session workspace.',
        )
      }
      publications.assertActive(sessionId)
      const stored = await transfer.snapshotLocal(args, cwd, exec.signal)
      const file = { ...stored, name: stored.ref.name }
      publications.publish(sessionId, file)
      return {
        name: file.name,
        mime_type: file.mediaType,
        bytes: file.ref.bytes,
        attachment_id: file.ref.attachmentId,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'publish_a2a_file', rawInput: displayName(args) }),
    presentResult: () => ({ card: 'generic' }),
  })
}

function displayName(args: { readonly path: string; readonly name?: string }): string {
  try {
    return safeFileName(args.name ?? args.path)
  } catch {
    return 'file'
  }
}
