import type { ModuleHtmlContract } from '@core/module-engine'
import { safeUrl } from '@modules/base/utils/escape'
import { normalizeIdentifierValue } from '@core/utils/identifier'
import { normalizeImportedText } from '@core/htmlImport'
import type {
  FormProps,
  LabelProps,
  InputProps,
  TextareaProps,
  SelectProps,
  OptionProps,
  OptionGroupProps,
  ChoiceProps,
  SubmitProps,
  FormMessageProps,
} from './types'

export const formHtmlContract: ModuleHtmlContract<FormProps> = {
  tag: 'form',
  attributes: (props) => {
    const formId = normalizeIdentifierValue(props.formId, 'form')
    const a: Record<string, string> = {
      'data-instatic-form-id': formId,
      'data-instatic-form-mode': String(props.mode),
    }
    if (props.mode === 'cms') a['data-instatic-target-table'] = String(props.targetTableId)
    if (props.mode === 'custom') {
      a['action'] = safeUrl(props.action) || ''
      a['method'] = String(props.method)
    }
    if (props.successBehavior === 'message') a['data-instatic-success-message'] = String(props.successMessage)
    if (props.successBehavior === 'redirect') a['data-instatic-success-redirect'] = safeUrl(props.redirectUrl) || ''
    return a
  },
  canHaveChildren: true,
  claimSelector: 'form[data-instatic-form-id]',
  fromHtml: (el) => ({
    formId: el.getAttribute('data-instatic-form-id') ?? 'form',
    mode: (el.getAttribute('data-instatic-form-mode') === 'custom' ? 'custom' : 'cms') as FormProps['mode'],
    targetTableId: el.getAttribute('data-instatic-target-table') ?? '',
    action: el.getAttribute('action') ?? '',
    method: (['get', 'post', 'dialog'].includes(el.getAttribute('method') ?? '') ? el.getAttribute('method') : 'post') as FormProps['method'],
  }),
}

export const labelHtmlContract: ModuleHtmlContract<LabelProps> = {
  tag: 'label',
  attributes: (props) => {
    const a: Record<string, string> = {}
    if (props.targetMode === 'explicit' && props.targetId) a['for'] = String(props.targetId)
    else a['data-instatic-label-target'] = 'auto'
    return a
  },
  textContent: (props) => String(props.text ?? ''),
  claimSelector: 'label',
  canHaveChildren: false,
  fromHtml: (el) => {
    // If the element has element children, skip the overlay and preserve
    // the DOM structure as a recursing DOM-native node.
    if (el.children.length > 0) return null
    return {
      text: normalizeImportedText(el.textContent ?? ''),
      targetMode: (el.getAttribute('for') ? 'explicit' : 'auto') as LabelProps['targetMode'],
      targetId: el.getAttribute('for') ?? '',
    }
  },
}

export const inputHtmlContract: ModuleHtmlContract<InputProps> = {
  tag: 'input',
  attributes: (props) => {
    const a: Record<string, string> = {
      'data-instatic-form-control': 'input',
      'data-instatic-field-id': String(props.fieldId),
      type: String(props.inputType),
      name: String(props.name || props.fieldId),
    }
    if (props.id) a['id'] = String(props.id)
    if (props.placeholder) a['placeholder'] = String(props.placeholder)
    if (props.value) a['value'] = String(props.value)
    if (props.autocomplete) a['autocomplete'] = String(props.autocomplete)
    if (props.min) a['min'] = String(props.min)
    if (props.max) a['max'] = String(props.max)
    if (props.pattern) a['pattern'] = String(props.pattern)
    if (props.required) a['required'] = ''
    if (props.disabled) a['disabled'] = ''
    if (props.readOnly) a['readonly'] = ''
    return a
  },
  claimSelector: 'input[data-instatic-form-control="input"]',
  canHaveChildren: false,
  fromHtml: (el) => ({
    inputType: (el.getAttribute('type') ?? 'text') as InputProps['inputType'],
    fieldId: el.getAttribute('data-instatic-field-id') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.getAttribute('id') ?? '',
    placeholder: el.getAttribute('placeholder') ?? '',
    value: el.getAttribute('value') ?? '',
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
    readOnly: el.hasAttribute('readonly'),
  }),
}

export const textareaHtmlContract: ModuleHtmlContract<TextareaProps> = {
  tag: 'textarea',
  attributes: (props) => {
    const a: Record<string, string> = {
      'data-instatic-form-control': 'textarea',
      'data-instatic-field-id': String(props.fieldId),
      name: String(props.name || props.fieldId),
      rows: String(props.rows),
    }
    if (props.id) a['id'] = String(props.id)
    if (props.placeholder) a['placeholder'] = String(props.placeholder)
    if (props.required) a['required'] = ''
    if (props.disabled) a['disabled'] = ''
    if (props.readOnly) a['readonly'] = ''
    return a
  },
  textContent: (props) => String(props.value ?? ''),
  claimSelector: 'textarea[data-instatic-form-control="textarea"]',
  canHaveChildren: false,
  fromHtml: (el) => ({
    fieldId: el.getAttribute('data-instatic-field-id') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.getAttribute('id') ?? '',
    placeholder: el.getAttribute('placeholder') ?? '',
    value: el.textContent ?? '',
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
    readOnly: el.hasAttribute('readonly'),
    rows: Number(el.getAttribute('rows') ?? 4),
  }),
}

export const selectHtmlContract: ModuleHtmlContract<SelectProps> = {
  tag: 'select',
  attributes: (props) => {
    const a: Record<string, string> = {
      'data-instatic-form-control': 'select',
      'data-instatic-field-id': String(props.fieldId),
      name: String(props.name || props.fieldId),
    }
    if (props.id) a['id'] = String(props.id)
    if (props.required) a['required'] = ''
    if (props.disabled) a['disabled'] = ''
    if (props.multiple) a['multiple'] = ''
    return a
  },
  canHaveChildren: true,
  claimSelector: 'select[data-instatic-form-control="select"]',
  fromHtml: (el) => ({
    fieldId: el.getAttribute('data-instatic-field-id') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.getAttribute('id') ?? '',
    required: el.hasAttribute('required'),
    disabled: el.hasAttribute('disabled'),
    multiple: el.hasAttribute('multiple'),
  }),
}

export const optionHtmlContract: ModuleHtmlContract<OptionProps> = {
  tag: 'option',
  attributes: (props) => {
    const a: Record<string, string> = { value: String(props.value) }
    if (props.selected) a['selected'] = ''
    if (props.disabled) a['disabled'] = ''
    return a
  },
  textContent: (props) => String(props.label ?? ''),
  claimSelector: 'option',
  canHaveChildren: false,
  fromHtml: (el) => ({
    value: el.getAttribute('value') ?? '',
    label: el.textContent ?? '',
    selected: el.hasAttribute('selected'),
    disabled: el.hasAttribute('disabled'),
  }),
}

export const optionGroupHtmlContract: ModuleHtmlContract<OptionGroupProps> = {
  tag: 'optgroup',
  attributes: (props) => {
    const a: Record<string, string> = { label: String(props.label) }
    if (props.disabled) a['disabled'] = ''
    return a
  },
  canHaveChildren: true,
  claimSelector: 'optgroup',
  fromHtml: (el) => ({
    label: el.getAttribute('label') ?? '',
    disabled: el.hasAttribute('disabled'),
  }),
}

export function choiceHtmlContract(inputType: 'checkbox' | 'radio'): ModuleHtmlContract<ChoiceProps> {
  return {
    tag: 'input',
    attributes: (props) => {
      const a: Record<string, string> = {
        type: inputType,
        'data-instatic-form-control': inputType,
        'data-instatic-field-id': String(props.fieldId),
        name: String(props.name || props.fieldId),
        value: String(props.value),
      }
      if (props.id) a['id'] = String(props.id)
      if (props.checked) a['checked'] = ''
      if (props.required) a['required'] = ''
      if (props.disabled) a['disabled'] = ''
      return a
    },
    claimSelector: `input[type="${inputType}"][data-instatic-form-control="${inputType}"]`,
    canHaveChildren: false,
    fromHtml: (el) => ({
      fieldId: el.getAttribute('data-instatic-field-id') ?? '',
      name: el.getAttribute('name') ?? '',
      id: el.getAttribute('id') ?? '',
      value: el.getAttribute('value') ?? 'on',
      checked: el.hasAttribute('checked'),
      required: el.hasAttribute('required'),
      disabled: el.hasAttribute('disabled'),
    }),
  }
}

export const submitHtmlContract: ModuleHtmlContract<SubmitProps> = {
  tag: 'button',
  attributes: (props) => {
    const a: Record<string, string> = { type: 'submit', form: normalizeIdentifierValue(props.formId) }
    if (props.disabled) a['disabled'] = ''
    return a
  },
  textContent: (props) => String(props.label ?? ''),
  claimSelector: 'button[type="submit"]',
  canHaveChildren: false,
  fromHtml: (el) => ({
    label: el.textContent ?? '',
    disabled: el.hasAttribute('disabled'),
    formId: el.getAttribute('form') ?? '',
  }),
}

export const formMessageHtmlContract: ModuleHtmlContract<FormMessageProps> = {
  tag: 'div',
  attributes: (props) => ({
    'data-instatic-form-message': String(props.kind),
    'data-instatic-form-id': normalizeIdentifierValue(props.formId),
    role: props.kind === 'error' ? 'alert' : 'status',
  }),
  textContent: (props) => String(props.text ?? ''),
  claimSelector: 'div[data-instatic-form-message]',
  canHaveChildren: false,
  fromHtml: (el) => ({
    formId: el.getAttribute('data-instatic-form-id') ?? '',
    kind: (['status', 'success', 'error'].includes(el.getAttribute('data-instatic-form-message') ?? '') ? el.getAttribute('data-instatic-form-message') : 'status') as FormMessageProps['kind'],
    text: el.textContent ?? '',
  }),
}
