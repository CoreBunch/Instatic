import type { PropertySchema } from '@core/module-engine'
import { escapeHtml } from '@core/publisher'
import type { FormControlBehavior } from '@core/forms-schema'

export const formBehaviorControls: PropertySchema = {
  requiredWhen: { type: 'condition', label: 'Required when', category: 'layout' },
  queryParameter: { type: 'text', label: 'Initial query parameter', category: 'layout' },
  lockQueryValue: { type: 'toggle', label: 'Lock a valid query value', category: 'layout' },
  resetBehavior: { type: 'select', label: 'After reset', category: 'layout', options: [{ label: 'Initial value', value: 'initial' }, { label: 'Clear value', value: 'clear' }, { label: 'Keep current value', value: 'preserve' }] },
  valueSourceField: { type: 'text', label: 'Value from control', category: 'layout' },
  requiredMessage: { type: 'text', label: 'Required value message' },
  invalidMessage: { type: 'text', label: 'Invalid value message' },
}

/** String props already passed publisher escaping; structured conditions have not. */
export function controlBehaviorAttrs(props: FormControlBehavior & { _formOriginalRequired?: boolean; _formOriginalDisabled?: boolean }): string {
  return ` data-instatic-required="${props._formOriginalRequired ?? props.required}" data-instatic-disabled="${props._formOriginalDisabled ?? props.disabled}"`
    + (props.requiredWhen ? ` data-instatic-required-when="${escapeHtml(JSON.stringify(props.requiredWhen))}"` : '')
    + ` data-instatic-query-parameter="${props.queryParameter}" data-instatic-value-source="${props.valueSourceField}"`
    + ` data-instatic-query-lock="${props.lockQueryValue}"`
    + ` data-instatic-reset-behavior="${props.resetBehavior}"`
    + ` data-instatic-required-message="${props.requiredMessage}" data-instatic-invalid-message="${props.invalidMessage}"`
}
