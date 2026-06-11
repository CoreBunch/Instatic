/**
 * base form primitives — semantic HTML form modules.
 *
 * Each form element is a real canvas node. Presets may insert these modules
 * together, but there is no hidden field-builder shape inside `base.form`.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import { normalizeIdentifierValue } from '@core/utils/identifier'
import { safeUrl } from '@modules/base/utils/escape'
import { FORM_RUNTIME_JS } from './formRuntimeJs'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { CheckboxSolidIcon } from 'pixel-art-icons/icons/checkbox-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import {
  CheckboxEditor,
  FormEditor,
  FormMessageEditor,
  InputEditor,
  LabelEditor,
  OptionEditor,
  OptionGroupEditor,
  RadioEditor,
  SelectEditor,
  SubmitEditor,
  TextareaEditor,
} from './FormControls'

const FormPropsSchema = Type.Object({
  mode: Type.Union([Type.Literal('cms'), Type.Literal('custom')], { default: 'cms' }),
  formId: Type.String({ default: 'form' }),
  targetTableId: Type.String({ default: '' }),
  action: Type.String({ default: '' }),
  method: Type.Union([Type.Literal('get'), Type.Literal('post'), Type.Literal('dialog')], { default: 'post' }),
  successBehavior: Type.Union([Type.Literal('message'), Type.Literal('redirect')], { default: 'message' }),
  successMessage: Type.String({ default: 'Thanks. Your submission was received.' }),
  redirectUrl: Type.String({ default: '' }),
  honeypotName: Type.String({ default: 'company' }),
  minSubmitSeconds: Type.Number({ default: 2 }),
})

type FormProps = Static<typeof FormPropsSchema>

const LabelPropsSchema = Type.Object({
  text: Type.String({ default: 'Label' }),
  targetMode: Type.Union([Type.Literal('auto'), Type.Literal('explicit')], { default: 'auto' }),
  targetId: Type.String({ default: '' }),
})

type LabelProps = Static<typeof LabelPropsSchema>

const InputPropsSchema = Type.Object({
  inputType: Type.Union([
    Type.Literal('text'),
    Type.Literal('email'),
    Type.Literal('password'),
    Type.Literal('search'),
    Type.Literal('tel'),
    Type.Literal('url'),
    Type.Literal('number'),
    Type.Literal('date'),
    Type.Literal('time'),
    Type.Literal('datetime-local'),
    Type.Literal('file'),
    Type.Literal('hidden'),
  ], { default: 'text' }),
  fieldId: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  id: Type.String({ default: '' }),
  placeholder: Type.String({ default: '' }),
  value: Type.String({ default: '' }),
  required: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
  readOnly: Type.Boolean({ default: false }),
  autocomplete: Type.String({ default: '' }),
  min: Type.String({ default: '' }),
  max: Type.String({ default: '' }),
  minLength: Type.Number({ default: 0 }),
  maxLength: Type.Number({ default: 0 }),
  pattern: Type.String({ default: '' }),
})

type InputProps = Static<typeof InputPropsSchema>

const TextareaPropsSchema = Type.Object({
  fieldId: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  id: Type.String({ default: '' }),
  placeholder: Type.String({ default: '' }),
  value: Type.String({ default: '' }),
  required: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
  readOnly: Type.Boolean({ default: false }),
  rows: Type.Number({ default: 4 }),
  minLength: Type.Number({ default: 0 }),
  maxLength: Type.Number({ default: 0 }),
})

type TextareaProps = Static<typeof TextareaPropsSchema>

const SelectPropsSchema = Type.Object({
  fieldId: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  id: Type.String({ default: '' }),
  required: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
  multiple: Type.Boolean({ default: false }),
})

type SelectProps = Static<typeof SelectPropsSchema>

const OptionPropsSchema = Type.Object({
  value: Type.String({ default: '' }),
  label: Type.String({ default: 'Option' }),
  selected: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
})

type OptionProps = Static<typeof OptionPropsSchema>

const OptionGroupPropsSchema = Type.Object({
  label: Type.String({ default: 'Group' }),
  disabled: Type.Boolean({ default: false }),
})

type OptionGroupProps = Static<typeof OptionGroupPropsSchema>

const ChoicePropsSchema = Type.Object({
  fieldId: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  id: Type.String({ default: '' }),
  value: Type.String({ default: 'on' }),
  checked: Type.Boolean({ default: false }),
  required: Type.Boolean({ default: false }),
  disabled: Type.Boolean({ default: false }),
})

type ChoiceProps = Static<typeof ChoicePropsSchema>

const SubmitPropsSchema = Type.Object({
  label: Type.String({ default: 'Submit' }),
  disabled: Type.Boolean({ default: false }),
  formId: Type.String({ default: '' }),
})

type SubmitProps = Static<typeof SubmitPropsSchema>

const FormMessagePropsSchema = Type.Object({
  formId: Type.String({ default: '' }),
  kind: Type.Union([Type.Literal('status'), Type.Literal('success'), Type.Literal('error')], { default: 'status' }),
  text: Type.String({ default: '' }),
})

type FormMessageProps = Static<typeof FormMessagePropsSchema>

export const FormModule: ModuleDefinition<FormProps> = {
  id: 'base.form',
  name: 'Form',
  description: 'A CMS-native or custom HTML form.',
  category: 'Forms',
  version: '1.0.0',
  icon: FileTextSolidIcon,
  trusted: true,
  canHaveChildren: true,
  schema: {
    mode: { type: 'select', label: 'Mode', options: [
      { label: 'CMS-native', value: 'cms' },
      { label: 'Custom action', value: 'custom' },
    ] },
    formId: { type: 'text', label: 'Form ID', normalize: 'identifier' },
    targetTableId: { type: 'dataTable', label: 'Target data table', condition: { field: 'mode', eq: 'cms' } },
    action: { type: 'url', label: 'Action URL', condition: { field: 'mode', eq: 'custom' } },
    method: { type: 'select', label: 'Method', condition: { field: 'mode', eq: 'custom' }, options: [
      { label: 'GET', value: 'get' },
      { label: 'POST', value: 'post' },
      { label: 'Dialog', value: 'dialog' },
    ] },
    successBehavior: { type: 'select', label: 'Success behavior', options: [
      { label: 'Show message', value: 'message' },
      { label: 'Redirect', value: 'redirect' },
    ] },
    successMessage: { type: 'text', label: 'Success message', condition: { field: 'successBehavior', eq: 'message' } },
    redirectUrl: { type: 'url', label: 'Redirect URL', condition: { field: 'successBehavior', eq: 'redirect' } },
    honeypotName: { type: 'text', label: 'Honeypot field', condition: { field: 'mode', eq: 'cms' } },
    minSubmitSeconds: { type: 'number', label: 'Minimum fill seconds', condition: { field: 'mode', eq: 'cms' } },
  },
  propsSchema: FormPropsSchema,
  defaults: Value.Create(FormPropsSchema),
  component: FormEditor,
  htmlTag: 'form',
  render: (props, renderedChildren) => {
    const formId = normalizeIdentifierValue(props.formId, 'form')
    const attrs = [
      `data-instatic-form-id="${formId}"`,
      `data-instatic-form-mode="${props.mode}"`,
      props.mode === 'cms' ? `data-instatic-target-table="${props.targetTableId}"` : '',
      props.mode === 'custom' ? `action="${safeUrl(props.action)}"` : '',
      props.mode === 'custom' ? `method="${props.method}"` : '',
      props.successBehavior === 'message' ? `data-instatic-success-message="${props.successMessage}"` : '',
      props.successBehavior === 'redirect' ? `data-instatic-success-redirect="${safeUrl(props.redirectUrl)}"` : '',
    ].filter(Boolean).join(' ')
    const honeypot = props.mode === 'cms'
      ? `<input type="text" name="${props.honeypotName}" autocomplete="off" tabindex="-1" data-instatic-honeypot hidden>`
      : ''
    return {
      html: `<form ${attrs}>${honeypot}${renderedChildren.join('')}</form>`,
      // CMS-native forms need the browser runtime; custom-action forms are
      // plain HTML form submissions and ship zero JS.
      ...(props.mode === 'cms' ? { js: FORM_RUNTIME_JS } : {}),
    }
  },
}

export const LabelModule: ModuleDefinition<LabelProps> = {
  id: 'base.label',
  name: 'Label',
  description: 'A label for a form control.',
  category: 'Forms',
  version: '1.0.0',
  icon: TextStartTIcon,
  trusted: true,
  canHaveChildren: false,
  schema: {
    text: { type: 'text', label: 'Text' },
    targetMode: { type: 'select', label: 'Target', options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Explicit', value: 'explicit' },
    ] },
    targetId: { type: 'text', label: 'Target ID', condition: { field: 'targetMode', eq: 'explicit' } },
  },
  propsSchema: LabelPropsSchema,
  defaults: Value.Create(LabelPropsSchema),
  component: LabelEditor,
  htmlTag: 'label',
  render: (props) => {
    if (props.targetMode === 'explicit' && props.targetId) {
      return { html: `<label for="${props.targetId}">${props.text}</label>` }
    }
    return { html: `<label data-instatic-label-target="auto">${props.text}</label>` }
  },
}

export const InputModule: ModuleDefinition<InputProps> = {
  id: 'base.input',
  name: 'Input',
  description: 'A single-line form input.',
  category: 'Forms',
  version: '1.0.0',
  icon: TextStartTIcon,
  trusted: true,
  canHaveChildren: false,
  schema: inputLikeSchema('Input type'),
  propsSchema: InputPropsSchema,
  defaults: Value.Create(InputPropsSchema),
  component: InputEditor,
  htmlTag: 'input',
  render: (props) => ({ html: `<input${attrs([
    ['data-instatic-form-control', 'input'],
    ['data-instatic-field-id', props.fieldId],
    ['type', props.inputType],
    ['name', props.name || props.fieldId],
    ['id', props.id],
    ['placeholder', props.placeholder],
    ['value', props.value],
    ['autocomplete', props.autocomplete],
    ['min', props.min],
    ['max', props.max],
    ['minlength', positiveNumber(props.minLength)],
    ['maxlength', positiveNumber(props.maxLength)],
    ['pattern', props.pattern],
  ])}${booleanAttrs(props, ['required', 'disabled', 'readOnly'])}>` }),
}

export const TextareaModule: ModuleDefinition<TextareaProps> = {
  id: 'base.textarea',
  name: 'Textarea',
  description: 'A multi-line form input.',
  category: 'Forms',
  version: '1.0.0',
  icon: TextStartTIcon,
  trusted: true,
  canHaveChildren: false,
  schema: {
    fieldId: { type: 'text', label: 'Field ID' },
    name: { type: 'text', label: 'Name' },
    id: { type: 'text', label: 'ID' },
    placeholder: { type: 'text', label: 'Placeholder' },
    value: { type: 'textarea', label: 'Default value' },
    required: { type: 'toggle', label: 'Required' },
    disabled: { type: 'toggle', label: 'Disabled' },
    readOnly: { type: 'toggle', label: 'Read-only' },
    rows: { type: 'number', label: 'Rows' },
    minLength: { type: 'number', label: 'Minimum length' },
    maxLength: { type: 'number', label: 'Maximum length' },
  },
  propsSchema: TextareaPropsSchema,
  defaults: Value.Create(TextareaPropsSchema),
  component: TextareaEditor,
  htmlTag: 'textarea',
  render: (props) => ({ html: `<textarea${attrs([
    ['data-instatic-form-control', 'textarea'],
    ['data-instatic-field-id', props.fieldId],
    ['name', props.name || props.fieldId],
    ['id', props.id],
    ['placeholder', props.placeholder],
    ['rows', props.rows],
    ['minlength', positiveNumber(props.minLength)],
    ['maxlength', positiveNumber(props.maxLength)],
  ])}${booleanAttrs(props, ['required', 'disabled', 'readOnly'])}>${props.value}</textarea>` }),
}

export const SelectModule: ModuleDefinition<SelectProps> = {
  id: 'base.select',
  name: 'Select',
  description: 'A select menu.',
  category: 'Forms',
  version: '1.0.0',
  icon: CheckboxSolidIcon,
  trusted: true,
  canHaveChildren: true,
  schema: {
    fieldId: { type: 'text', label: 'Field ID' },
    name: { type: 'text', label: 'Name' },
    id: { type: 'text', label: 'ID' },
    required: { type: 'toggle', label: 'Required' },
    disabled: { type: 'toggle', label: 'Disabled' },
    multiple: { type: 'toggle', label: 'Multiple' },
  },
  propsSchema: SelectPropsSchema,
  defaults: Value.Create(SelectPropsSchema),
  component: SelectEditor,
  htmlTag: 'select',
  render: (props, renderedChildren) => ({
    html: `<select${attrs([
      ['data-instatic-form-control', 'select'],
      ['data-instatic-field-id', props.fieldId],
      ['name', props.name || props.fieldId],
      ['id', props.id],
    ])}${booleanAttrs(props, ['required', 'disabled', 'multiple'])}>${renderedChildren.join('')}</select>`,
  }),
}

export const OptionModule: ModuleDefinition<OptionProps> = {
  id: 'base.option',
  name: 'Option',
  description: 'An option inside a select.',
  category: 'Forms',
  version: '1.0.0',
  icon: CheckboxSolidIcon,
  trusted: true,
  canHaveChildren: false,
  schema: {
    value: { type: 'text', label: 'Value' },
    label: { type: 'text', label: 'Label' },
    selected: { type: 'toggle', label: 'Selected' },
    disabled: { type: 'toggle', label: 'Disabled' },
  },
  propsSchema: OptionPropsSchema,
  defaults: Value.Create(OptionPropsSchema),
  component: OptionEditor,
  htmlTag: 'option',
  render: (props) => ({ html: `<option${attrs([['value', props.value]])}${booleanAttrs(props, ['selected', 'disabled'])}>${props.label}</option>` }),
}

export const OptionGroupModule: ModuleDefinition<OptionGroupProps> = {
  id: 'base.option-group',
  name: 'Option group',
  description: 'A group of select options.',
  category: 'Forms',
  version: '1.0.0',
  icon: CheckboxSolidIcon,
  trusted: true,
  canHaveChildren: true,
  schema: {
    label: { type: 'text', label: 'Label' },
    disabled: { type: 'toggle', label: 'Disabled' },
  },
  propsSchema: OptionGroupPropsSchema,
  defaults: Value.Create(OptionGroupPropsSchema),
  component: OptionGroupEditor,
  htmlTag: 'optgroup',
  render: (props, renderedChildren) => ({
    html: `<optgroup${attrs([['label', props.label]])}${booleanAttrs(props, ['disabled'])}>${renderedChildren.join('')}</optgroup>`,
  }),
}

export const CheckboxModule: ModuleDefinition<ChoiceProps> = choiceModule({
  id: 'base.checkbox',
  name: 'Checkbox',
  inputType: 'checkbox',
  component: CheckboxEditor,
})

export const RadioModule: ModuleDefinition<ChoiceProps> = choiceModule({
  id: 'base.radio',
  name: 'Radio',
  inputType: 'radio',
  component: RadioEditor,
})

export const SubmitModule: ModuleDefinition<SubmitProps> = {
  id: 'base.submit',
  name: 'Submit',
  description: 'A submit button.',
  category: 'Forms',
  version: '1.0.0',
  icon: SendSolidIcon,
  trusted: true,
  canHaveChildren: false,
  schema: {
    label: { type: 'text', label: 'Label' },
    disabled: { type: 'toggle', label: 'Disabled' },
    formId: { type: 'text', label: 'Form ID override', normalize: 'identifier' },
  },
  propsSchema: SubmitPropsSchema,
  defaults: Value.Create(SubmitPropsSchema),
  component: SubmitEditor,
  htmlTag: 'button',
  render: (props) => ({
    html: `<button type="submit"${attrs([['form', normalizeIdentifierValue(props.formId)]])}${booleanAttrs(props, ['disabled'])}>${props.label}</button>`,
  }),
}

export const FormMessageModule: ModuleDefinition<FormMessageProps> = {
  id: 'base.form-message',
  name: 'Form message',
  description: 'A status, success, or error message for a form.',
  category: 'Forms',
  version: '1.0.0',
  icon: WarningDiamondSolidIcon,
  trusted: true,
  canHaveChildren: false,
  schema: {
    formId: { type: 'text', label: 'Form ID', normalize: 'identifier' },
    kind: { type: 'select', label: 'Kind', options: [
      { label: 'Status', value: 'status' },
      { label: 'Success', value: 'success' },
      { label: 'Error', value: 'error' },
    ] },
    text: { type: 'text', label: 'Text' },
  },
  propsSchema: FormMessagePropsSchema,
  defaults: Value.Create(FormMessagePropsSchema),
  component: FormMessageEditor,
  htmlTag: 'div',
  render: (props) => ({
    html: `<div data-instatic-form-message="${props.kind}" data-instatic-form-id="${normalizeIdentifierValue(props.formId)}" role="${props.kind === 'error' ? 'alert' : 'status'}">${props.text}</div>`,
  }),
}

function inputLikeSchema(typeLabel: string): ModuleDefinition<InputProps>['schema'] {
  return {
    inputType: { type: 'select', label: typeLabel, options: [
      'text',
      'email',
      'password',
      'search',
      'tel',
      'url',
      'number',
      'date',
      'time',
      'datetime-local',
      'file',
      'hidden',
    ].map((value) => ({ label: value, value })) },
    fieldId: { type: 'text', label: 'Field ID' },
    name: { type: 'text', label: 'Name' },
    id: { type: 'text', label: 'ID' },
    placeholder: { type: 'text', label: 'Placeholder' },
    value: { type: 'text', label: 'Default value' },
    required: { type: 'toggle', label: 'Required' },
    disabled: { type: 'toggle', label: 'Disabled' },
    readOnly: { type: 'toggle', label: 'Read-only' },
    autocomplete: { type: 'text', label: 'Autocomplete' },
    min: { type: 'text', label: 'Min' },
    max: { type: 'text', label: 'Max' },
    minLength: { type: 'number', label: 'Minimum length' },
    maxLength: { type: 'number', label: 'Maximum length' },
    pattern: { type: 'text', label: 'Pattern' },
  }
}

function choiceModule(args: {
  id: 'base.checkbox' | 'base.radio'
  name: string
  inputType: 'checkbox' | 'radio'
  component: ModuleDefinition<ChoiceProps>['component']
}): ModuleDefinition<ChoiceProps> {
  return {
    id: args.id,
    name: args.name,
    description: `A ${args.inputType} form control.`,
    category: 'Forms',
    version: '1.0.0',
    icon: CheckboxSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: {
      fieldId: { type: 'text', label: 'Field ID' },
      name: { type: 'text', label: 'Name' },
      id: { type: 'text', label: 'ID' },
      value: { type: 'text', label: 'Value' },
      checked: { type: 'toggle', label: 'Checked' },
      required: { type: 'toggle', label: 'Required' },
      disabled: { type: 'toggle', label: 'Disabled' },
    },
    propsSchema: ChoicePropsSchema,
    defaults: Value.Create(ChoicePropsSchema),
    component: args.component,
    htmlTag: 'input',
    render: (props) => ({
      html: `<input type="${args.inputType}"${attrs([
        ['data-instatic-form-control', args.inputType],
        ['data-instatic-field-id', props.fieldId],
        ['name', props.name || props.fieldId],
        ['id', props.id],
        ['value', props.value],
      ])}${booleanAttrs(props, ['checked', 'required', 'disabled'])}>`,
    }),
  }
}

function attrs(values: Array<[string, string | number | null | undefined]>): string {
  return values
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => ` ${name}="${String(value)}"`)
    .join('')
}

function booleanAttrs(
  props: Record<string, unknown>,
  names: string[],
): string {
  return names
    .filter((name) => Boolean(props[name]))
    .map((name) => name === 'readOnly' ? ' readonly' : ` ${name}`)
    .join('')
}

function positiveNumber(value: number): number | undefined {
  return value > 0 ? value : undefined
}

registry.registerOrReplace(FormModule)
registry.registerOrReplace(LabelModule)
registry.registerOrReplace(InputModule)
registry.registerOrReplace(TextareaModule)
registry.registerOrReplace(SelectModule)
registry.registerOrReplace(OptionModule)
registry.registerOrReplace(OptionGroupModule)
registry.registerOrReplace(CheckboxModule)
registry.registerOrReplace(RadioModule)
registry.registerOrReplace(SubmitModule)
registry.registerOrReplace(FormMessageModule)
