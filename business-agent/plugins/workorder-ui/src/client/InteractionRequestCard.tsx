import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { parseInteractionRequest, submissionMessage, type InteractionField } from './interaction-data.ts'
import type {} from './locales.ts'
import css from './InteractionRequestCard.module.css'

type Props = ToolCallViewProps & PropsLocale<'businessWorkorder'>

function initialValue(field: InteractionField): unknown {
  if (field.type === 'boolean') return false
  if (field.type === 'multi-select') return []
  return ''
}

function Field({ field, value, setValue }: {
  field: InteractionField
  value: unknown
  setValue: (value: unknown) => void
}): ReactNode {
  const common = { id: field.id, name: field.id, required: field.required, className: css.control }
  if (field.type === 'textarea') return <textarea {...common} rows={3} placeholder={field.placeholder} value={String(value)} onChange={event => { setValue(event.target.value) }} />
  if (field.type === 'select') return (
    <select {...common} value={String(value)} onChange={event => { setValue(event.target.value) }}>
      <option value="" disabled>—</option>
      {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
  if (field.type === 'multi-select') return (
    <div className={css.choiceList}>
      {field.options?.map(option => (
        <label key={option.value} className={css.choice}>
          <input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={event => {
            const current = Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
            setValue(event.target.checked ? [...current, option.value] : current.filter(item => item !== option.value))
          }} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
  if (field.type === 'boolean') return (
    <label className={css.switchLine}>
      <input id={field.id} name={field.id} type="checkbox" checked={value === true} required={field.const === true} onChange={event => { setValue(event.target.checked) }} />
      <span>{field.label}</span>
    </label>
  )
  const inputType = field.type === 'integer' ? 'number' : field.type === 'date' ? 'date' : 'text'
  return <input {...common} type={inputType} min={field.min} max={field.max} placeholder={field.type === 'resource' ? 'resourceId' : field.placeholder} value={String(value)} onChange={(event: ChangeEvent<HTMLInputElement>) => { setValue(field.type === 'integer' ? event.target.valueAsNumber : event.target.value) }} />
}

/** Create the Session-aware structured interaction tool view. */
export function createInteractionRequestCard(ctx: ClientContext) {
  return function InteractionRequestCard({ block, sessionId, t }: Props): ReactNode {
    const request = parseInteractionRequest('kind' in block && block.kind === 'tool-result' ? block.meta : undefined)
    const initial = useMemo(() => Object.fromEntries(request?.fields.map(field => [field.id, initialValue(field)]) ?? []), [request])
    const [values, setValues] = useState<Record<string, unknown>>(initial)
    const [state, setState] = useState<'editing' | 'sending' | 'sent' | 'failed'>('editing')
    useEffect(() => {
      if (request === null) return
      setValues(initial)
      setState('editing')
    }, [initial, request])
    if (request === null) return <div className={css.invalid}>{t('interaction.invalid')}</div>

    const submit = async (event: FormEvent): Promise<void> => {
      event.preventDefault()
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) {
        setState('failed')
        return
      }
      setState('sending')
      const normalized = Object.fromEntries(request.fields.map(field => [
        field.id,
        field.type === 'resource' ? { resourceId: String(values[field.id] ?? '') } : values[field.id],
      ]))
      const key = `${request.interactionId}-${globalThis.crypto.randomUUID()}`
      try {
        const result = await session.prompt([{ type: 'text', text: submissionMessage(request, normalized, key) }], 'queue')
        setState(result.ok ? 'sent' : 'failed')
      } catch (error) {
        // An unmounted Remote method is an assembly failure, not a business response.
        void error
        setState('failed')
      }
    }

    return (
      <form className={css.card} onSubmit={event => { void submit(event) }} data-state={state}>
        <header className={css.header}>
          <span className={css.kicker}>{t('interaction.kicker')}</span>
          <h3>{request.presentation.title}</h3>
          <p>{request.presentation.description}</p>
        </header>
        <div className={css.fields}>
          {request.fields.map(field => (
            <div className={css.field} key={field.id}>
              {field.type !== 'boolean' && <label htmlFor={field.id}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>}
              <Field field={field} value={values[field.id]} setValue={value => { setValues(current => ({ ...current, [field.id]: value })) }} />
            </div>
          ))}
        </div>
        <footer className={css.footer}>
          {state === 'failed' && <span role="alert">{t('interaction.failed')}</span>}
          {state === 'sent' && <span role="status">{t('interaction.sent')}</span>}
          <button type="submit" disabled={state === 'sending' || state === 'sent'}>
            {state === 'sending' ? t('interaction.sending') : t('interaction.submit')}
          </button>
        </footer>
      </form>
    )
  }
}
