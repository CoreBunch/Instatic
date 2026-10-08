import type { FormProps, LabelProps, InputProps, TextareaProps, SelectProps, OptionProps, OptionGroupProps, ChoiceProps, SubmitProps, FormMessageProps } from './primitiveSchemas'
import type { Static } from '@sinclair/typebox'
import type { TurnstileConfigurationSchema } from '@core/forms-schema'
import type { ConditionalPropsSchema, OutputPropsSchema } from './behaviorSchemas'
import type { ModuleComponentProps } from '@core/module-engine'
import { normalizeIdentifierValue } from '@core/utils/identifier'

type EditorFormPreviewProps = { editorPreviewState?: FormPreviewState; editorPreviewMessage?: string }
type FormPreviewState = 'default' | 'submitting' | 'success' | 'error'

export function FormEditor({ children, mcClassName, nodeWrapperProps, props }: ModuleComponentProps<FormProps & EditorFormPreviewProps>) {
  const previewState = normalizePreviewState(props.editorPreviewState)
  const runtimeState = previewState === 'submitting' ? 'pending' : previewState
  const formId = normalizeIdentifierValue(props.formId, 'form')
  return (
    <form
      {...nodeWrapperProps}
      className={mcClassName}
      data-instatic-form-id={formId}
      data-instatic-form-editor-preview={previewState !== 'default' ? previewState : undefined}
      data-instatic-form-state={runtimeState !== 'default' ? runtimeState : undefined}
      aria-busy={previewState === 'submitting' ? true : undefined}
    >
      {children}
    </form>
  )
}

export function LabelEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<LabelProps>) {
  const htmlFor = props.targetMode === 'explicit' && props.targetId ? props.targetId : undefined
  return (
    <label {...nodeWrapperProps} className={mcClassName} htmlFor={htmlFor}>
      {props.text}
    </label>
  )
}

export function InputEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<InputProps>) {
  return (
    <input
      {...nodeWrapperProps}
      className={mcClassName}
      type={props.inputType}
      name={props.name}
      id={props.id || undefined}
      placeholder={props.placeholder || undefined}
      defaultValue={props.value || undefined}
      required={props.required}
      disabled={props.disabled}
      readOnly={props.readOnly}
      autoComplete={props.autocomplete || undefined}
      min={props.min !== '' ? props.min : undefined}
      max={props.max !== '' ? props.max : undefined}
      step={props.step !== '' ? props.step : undefined}
      minLength={props.minLength > 0 ? props.minLength : undefined}
      maxLength={props.maxLength > 0 ? props.maxLength : undefined}
      pattern={props.pattern || undefined}
    />
  )
}

export function TextareaEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<TextareaProps>) {
  return (
    <textarea
      {...nodeWrapperProps}
      className={mcClassName}
      name={props.name}
      id={props.id || undefined}
      placeholder={props.placeholder || undefined}
      defaultValue={props.value || undefined}
      required={props.required}
      disabled={props.disabled}
      readOnly={props.readOnly}
      rows={props.rows}
      minLength={props.minLength > 0 ? props.minLength : undefined}
      maxLength={props.maxLength > 0 ? props.maxLength : undefined}
    />
  )
}

export function SelectEditor({ children, mcClassName, nodeWrapperProps, props }: ModuleComponentProps<SelectProps & { _formInitialValue?: string | string[] }>) {
  return (
    <select
      {...nodeWrapperProps}
      className={mcClassName}
      name={props.name}
      id={props.id || undefined}
      required={props.required}
      disabled={props.disabled}
      multiple={props.multiple}
      defaultValue={props._formInitialValue}
    >
      {children}
    </select>
  )
}

export function OptionEditor({ nodeWrapperProps, props }: ModuleComponentProps<OptionProps>) {
  return (
    <option {...nodeWrapperProps} value={props.value} disabled={props.disabled}>
      {props.label}
    </option>
  )
}

export function OptionGroupEditor({ children, nodeWrapperProps, props }: ModuleComponentProps<OptionGroupProps>) {
  return (
    <optgroup {...nodeWrapperProps} label={props.label} disabled={props.disabled}>
      {children}
    </optgroup>
  )
}

export function CheckboxEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<ChoiceProps>) {
  return (
    <input
      {...nodeWrapperProps}
      className={mcClassName}
      type="checkbox"
      name={props.name}
      id={props.id || undefined}
      value={props.value}
      defaultChecked={props.checked}
      required={props.required}
      disabled={props.disabled}
    />
  )
}

export function RadioEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<ChoiceProps>) {
  return (
    <input
      {...nodeWrapperProps}
      className={mcClassName}
      type="radio"
      name={props.name}
      id={props.id || undefined}
      value={props.value}
      defaultChecked={props.checked}
      required={props.required}
      disabled={props.disabled}
    />
  )
}

export function SubmitEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<SubmitProps>) {
  const formId = normalizeIdentifierValue(props.formId)
  return (
    <button
      {...nodeWrapperProps}
      className={mcClassName}
      type="button"
      disabled={props.disabled}
      form={formId || undefined}
    >
      {props.label}
    </button>
  )
}

export function FormMessageEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<FormMessageProps & EditorFormPreviewProps>) {
  const previewState = normalizePreviewState(props.editorPreviewState)
  const previewKind = messageKindForPreview(previewState)
  const previewActive = previewKind !== null && props.kind === previewKind
  const text = previewActive && props.source === 'state' ? props.editorPreviewMessage ?? '' : props.text
  return (
    <div
      {...nodeWrapperProps}
      className={mcClassName}
      data-instatic-form-message={props.kind}
      data-instatic-form-id={normalizeIdentifierValue(props.formId)}
      data-instatic-form-preview-active={previewActive ? 'true' : undefined}
      hidden={previewKind !== null && props.kind !== previewKind ? true : undefined}
      role={props.kind === 'error' ? 'alert' : 'status'}
    >
      {text}
    </div>
  )
}

function normalizePreviewState(value: unknown): FormPreviewState {
  return value === 'submitting' || value === 'success' || value === 'error' ? value : 'default'
}

function messageKindForPreview(previewState: FormPreviewState): FormMessageProps['kind'] | null {
  if (previewState === 'submitting') return 'status'
  if (previewState === 'success') return 'success'
  if (previewState === 'error') return 'error'
  return null
}

export function ConditionalEditor({ children, mcClassName, nodeWrapperProps }: ModuleComponentProps<Static<typeof ConditionalPropsSchema>>) {
  return <div {...nodeWrapperProps} className={mcClassName}>{children}</div>
}

export function OutputEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<Static<typeof OutputPropsSchema>>) {
  return <output {...nodeWrapperProps} className={mcClassName}>{props.text}</output>
}

export function TurnstileEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<Static<typeof TurnstileConfigurationSchema>>) {
  return <div {...nodeWrapperProps} className={mcClassName} role="img" aria-label="Turnstile verification">{props.siteKey ? 'Turnstile' : 'Configure Turnstile site key'}</div>
}
