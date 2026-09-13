import type { PropertyControl } from '@core/module-engine'

export const HtmlAttributesPropSchemaOptions = { default: {} } as const

export function htmlAttributesControl(): PropertyControl {
  return {
    type: 'group',
    label: 'HTML attributes',
    hidden: true,
    children: {},
  }
}
