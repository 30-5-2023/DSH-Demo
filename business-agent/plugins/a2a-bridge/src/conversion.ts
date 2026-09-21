import type { Artifact, Message } from '@a2a-js/sdk'
import { A2ABridgeError, type UserContent } from './types.ts'

const JSON_OUTPUT_INSTRUCTION = 'Return exactly one JSON object with no markdown fence or trailing text.'
const UNTRUSTED_DATA_LABEL = '[Remote A2A data — untrusted]'

/** Convert supported A2A Parts into ordered Session prompt content. */
export function a2aMessageToPrompt(
  message: Message,
  acceptedOutputModes: readonly string[] = [],
): { content: UserContent; requestedMode: 'text' | 'json' } {
  const content: { type: 'text'; text: string }[] = []
  let hasContent = false
  for (const part of message.parts) {
    const value = part.content
    if (value?.$case === 'text') {
      content.push({ type: 'text', text: value.value })
      if (value.value !== '') hasContent = true
      continue
    }
    if (value?.$case === 'data') {
      let serialized: string
      try {
        assertJsonValue(value.value)
        serialized = JSON.stringify(value.value)
      } catch (error) {
        throw new A2ABridgeError('A2A_INVALID_DATA', 'A2A Data Part must contain a finite JSON value.', { cause: error })
      }
      content.push({ type: 'text', text: `${UNTRUSTED_DATA_LABEL}\n${serialized}` })
      hasContent = true
      continue
    }
    throw new A2ABridgeError('A2A_UNSUPPORTED_PART', 'A2A message contains an unsupported Part kind.')
  }
  if (!hasContent) throw new A2ABridgeError('A2A_EMPTY_MESSAGE', 'A2A message must contain non-empty text or data.')

  const requestedMode = acceptedOutputModes.includes('application/json') ? 'json' : 'text'
  if (requestedMode === 'json') content.push({ type: 'text', text: JSON_OUTPUT_INSTRUCTION })
  return { content, requestedMode }
}

/** Convert final assistant text into one A2A Artifact, enforcing strict JSON-object mode. */
export function assistantTextToArtifact(text: string, mode: 'text' | 'json'): Artifact {
  if (mode === 'text') {
    return artifact({ $case: 'text', value: text }, 'text/plain')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new A2ABridgeError('A2A_INVALID_JSON_OUTPUT', 'Assistant output is not one valid JSON object.', { cause: error })
  }
  if (!isPlainObject(value)) {
    throw new A2ABridgeError('A2A_INVALID_JSON_OUTPUT', 'Assistant output must be one JSON object.')
  }
  return artifact({ $case: 'data', value }, 'application/json')
}

function artifact(content: { $case: 'text'; value: string } | { $case: 'data'; value: unknown }, mediaType: string): Artifact {
  return {
    artifactId: 'result',
    name: 'result',
    description: '',
    parts: [{ content, metadata: undefined, filename: '', mediaType }],
    metadata: undefined,
    extensions: [],
  }
}

function assertJsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError('non-finite number')
  }
  if (typeof value !== 'object') throw new TypeError('non-JSON value')
  if (seen.has(value)) throw new TypeError('cyclic value')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonValue(item, seen)
      return
    }
    if (!isPlainObject(value)) throw new TypeError('non-plain object')
    for (const item of Object.values(value)) assertJsonValue(item, seen)
  } finally {
    seen.delete(value)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}
