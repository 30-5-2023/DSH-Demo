import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** Deterministic text model for the real-Loader A2A vertical slice. */
class A2AScriptedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000 })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const inputs = options.messages
      .filter(message => message.role === 'user')
      .map(message => message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(''))
      .filter(text => /^(one|two|other|stream|hold|three|peer-call)$/.test(text))
    const input = inputs.at(-1) ?? ''
    if (input === 'hold') await waitForAbort(options.signal)
    const text = `reply:${input}:turns=${String(inputs.length)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) return Promise.reject(new Error('A2A scripted hold requires cancellation'))
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

/** Stable Cordis fixture plugin name. */
export const name = 'business-a2a-scripted-llm'
/** LLM registry required by the fixture adapter. */
export const inject = ['llm']

/** Register the deterministic adapter on the Business Agent's default route. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.llm.registerAdapter(['deepseek-official'], new A2AScriptedAdapter()),
    'business-a2a-scripted-llm.adapter',
  )
}
