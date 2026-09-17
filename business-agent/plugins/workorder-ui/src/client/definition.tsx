import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconChecklistOutline14, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'

/** Stable implementation identity used by the tab registry and body slot. */
export const WORKORDER_ID = '@deepseek-ai/dsh-business-workorder-ui'

/** Page kind opened from the right Sidebar guide. */
export const WORKORDER_KIND = 'business-workorder'

/** Work-order glyph at the guide's requested size. */
function WorkorderGlyph({ size, className }: IconProps) {
  return <IconChecklistOutline14 size={size} className={className} />
}

/**
 * Create the work-order page definition.
 * @param t Namespace-bound translator.
 * @returns Right Sidebar tab definition.
 */
export function workorderDefinition(t: TranslateNS<'businessWorkorder'>): SidebarRightTabDefinition {
  return {
    id: WORKORDER_ID,
    kind: WORKORDER_KIND,
    priority: 'extension',
    title: () => t('type.label'),
    guide: [{
      id: 'current-order',
      order: 20,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: WorkorderGlyph,
    }],
  }
}
