import { evaluateCondition, PropertyConditionSchema } from '@core/module-engine-schema'
import { compiledCheck } from '@core/utils/typeboxCompiler'

export type FormRenderContext = { readonly values: Record<string, unknown>; readonly active: boolean }

/** Initial HTML follows the same declared conditions as the browser behavior. */
export function resolveFormRenderProps(moduleId: string, props: Record<string, unknown>, context: FormRenderContext | undefined) {
  if (!context) return { props, context }
  if (moduleId === 'base.form-conditional') {
    const active = context.active && (!compiledCheck(PropertyConditionSchema, props.condition) || evaluateCondition(props.condition, context.values))
    return { props: { ...props, _formConditionVisible: active }, context: { ...context, active } }
  }
  if (['base.input','base.textarea','base.select','base.checkbox','base.radio'].includes(moduleId)) {
    const required = compiledCheck(PropertyConditionSchema, props.requiredWhen) ? evaluateCondition(props.requiredWhen, context.values) : props.required === true
    const source = typeof props.valueSourceField === 'string' ? props.valueSourceField : ''
    return { props: {
      ...props, _formOriginalRequired: props.required === true, _formOriginalDisabled: props.disabled === true,
      required: context.active && required, disabled: !context.active || props.disabled === true,
      ...(source ? { value: String(context.values[source] ?? '') } : {}),
    }, context }
  }
  if (moduleId === 'base.form-output' && typeof props.fieldName === 'string') return { props: { ...props, text: String(context.values[props.fieldName] ?? '') }, context }
  return { props, context }
}
