import type { ModuleComponentProps } from '@core/module-engine'
import { normalizeIdentifierValue } from '@core/utils/identifier'
import { submitUsesChildren } from './content'

type FormProps = Record<string, unknown> & {
  formId: string
  editorPreviewState?: FormPreviewState
}

type LabelProps = Record<string, unknown> & {
  text: string
  targetMode: 'auto' | 'explicit'
  targetId: string
}

type InputProps = Record<string, unknown> & {
  inputType: string
  name: string
  id: string
  placeholder: string
  value: string
  required: boolean
  disabled: boolean
  readOnly: boolean
  autocomplete: string
}

type TextareaProps = Record<string, unknown> & {
  name: string
  id: string
  placeholder: string
  value: string
  required: boolean
  disabled: boolean
  readOnly: boolean
  rows: number
}

type SelectProps = Record<string, unknown> & {
  name: string
  id: string
  required: boolean
  disabled: boolean
  multiple: boolean
}

type OptionProps = Record<string, unknown> & {
  value: string
  label: string
  selected: boolean
  disabled: boolean
}

type OptionGroupProps = Record<string, unknown> & {
  label: string
  disabled: boolean
}

type ChoiceProps = Record<string, unknown> & {
  name: string
  id: string
  value: string
  checked: boolean
  required: boolean
  disabled: boolean
}

type SubmitProps = Record<string, unknown> & {
  label: string
  disabled: boolean
  formId: string
}

type FormMessageProps = Record<string, unknown> & {
  formId: string
  kind: 'status' | 'success' | 'error'
  text: string
  editorPreviewState?: FormPreviewState
  editorPreviewSuccessMessage?: string
}

type FormPreviewState = 'default' | 'submitting' | 'success' | 'error'

export function FormEditor({ children, mcClassName, nodeWrapperProps, props }: ModuleComponentProps<FormProps>) {
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
    />
  )
}

export function SelectEditor({ children, mcClassName, nodeWrapperProps, props }: ModuleComponentProps<SelectProps>) {
  return (
    <select
      {...nodeWrapperProps}
      className={mcClassName}
      name={props.name}
      id={props.id || undefined}
      required={props.required}
      disabled={props.disabled}
      multiple={props.multiple}
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

export function SubmitEditor({ mcClassName, nodeWrapperProps, props, children }: ModuleComponentProps<SubmitProps>) {
  const formId = normalizeIdentifierValue(props.formId)
  const childCount = Array.isArray(children) ? children.length : children != null ? 1 : 0
  return (
    <button
      {...nodeWrapperProps}
      className={mcClassName}
      type="button"
      disabled={props.disabled}
      form={formId || undefined}
    >
      {submitUsesChildren(childCount) ? children : props.label}
    </button>
  )
}

export function FormMessageEditor({ mcClassName, nodeWrapperProps, props }: ModuleComponentProps<FormMessageProps>) {
  const previewState = normalizePreviewState(props.editorPreviewState)
  const previewKind = messageKindForPreview(previewState)
  const previewActive = previewKind !== null && props.kind === previewKind
  const text = previewActive
    ? previewTextForMessage(props.kind, props.text, props.editorPreviewSuccessMessage)
    : props.text
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

function previewTextForMessage(
  kind: FormMessageProps['kind'],
  text: string,
  successMessage: string | undefined,
): string {
  if (text) return text
  if (kind === 'status') return 'Sending...'
  if (kind === 'success') return successMessage || 'Thanks. Your submission was received.'
  return 'Please check the form and try again.'
}
