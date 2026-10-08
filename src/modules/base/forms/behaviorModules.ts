import type { ModuleDefinition } from '@core/module-engine'
import { TurnstileConfigurationSchema, TURNSTILE_LANGUAGES } from '@core/forms-schema'
import { Value, type Static } from '@core/utils/typeboxHelpers'
import { escapeHtml } from '@core/publisher'
import { ConditionalPropsSchema, OutputPropsSchema } from './behaviorSchemas'
import { ConditionalEditor, OutputEditor, TurnstileEditor } from './FormControls'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'

type ConditionalProps = Static<typeof ConditionalPropsSchema>
type OutputProps = Static<typeof OutputPropsSchema>

export const FormConditionalModule: ModuleDefinition<ConditionalProps> = {
  id: 'base.form-conditional', name: 'Form condition', category: 'Forms', version: '1.0.0',
  description: 'Show a group when control values match a declared condition.',
  icon: FileTextSolidIcon, trusted: true, canHaveChildren: true, htmlTag: 'div',
  schema: { condition: { type: 'condition', label: 'Visible when', category: 'layout' } },
  propsSchema: ConditionalPropsSchema, defaults: Value.Create(ConditionalPropsSchema), component: ConditionalEditor,
  assets: { css: '[data-instatic-form-condition][hidden]{display:none}' },
  render: (props, children) => ({
    html: `<div data-instatic-form-condition="${escapeHtml(JSON.stringify(props.condition))}"${'_formConditionVisible' in props && props._formConditionVisible === false ? ' hidden' : ''}>${children.join('')}</div>`,
  }),
}

export const FormOutputModule: ModuleDefinition<OutputProps> = {
  id: 'base.form-output', name: 'Form value', category: 'Forms', version: '1.0.0',
  description: 'Display a named control value as plain text.',
  icon: FileTextSolidIcon, trusted: true, canHaveChildren: false, htmlTag: 'output',
  schema: { fieldName: { type: 'text', label: 'Control name', category: 'layout' }, text: { type: 'text', label: 'Initial text' } },
  propsSchema: OutputPropsSchema, defaults: Value.Create(OutputPropsSchema), component: OutputEditor,
  render: (props) => ({ html: `<output data-instatic-form-output="${props.fieldName}">${props.text}</output>` }),
}

type TurnstileProps = Static<typeof TurnstileConfigurationSchema>
export const TurnstileModule: ModuleDefinition<TurnstileProps> = {
  id: 'base.turnstile', name: 'Turnstile', category: 'Forms', version: '1.0.0',
  description: 'A verification widget for a form whose recipient verifies the token.',
  icon: FileTextSolidIcon, trusted: true, canHaveChildren: false, htmlTag: 'div',
  schema: {
    siteKey: { type: 'text', label: 'Public site key', category: 'layout' },
    action: { type: 'text', label: 'Action', category: 'layout' },
    language: { type: 'select', label: 'Language', options: TURNSTILE_LANGUAGES.map((value) => ({ value, label: value })) },
    theme: { type: 'select', label: 'Theme', options: ['auto', 'light', 'dark'].map((value) => ({ label: value, value })) },
    responseFieldName: { type: 'text', label: 'Response field name', category: 'layout' },
  },
  propsSchema: TurnstileConfigurationSchema,
  defaults: { siteKey: '', action: '', language: 'auto', theme: 'auto', responseFieldName: 'cf-turnstile-response' },
  component: TurnstileEditor,
  render: (props) => ({
    html: `<div data-instatic-turnstile data-instatic-site-key="${props.siteKey}" data-instatic-captcha-action="${props.action}" data-instatic-captcha-language="${props.language}" data-instatic-captcha-theme="${props.theme}" data-instatic-captcha-field="${props.responseFieldName}"></div>`,
    cspSources: [
      { directive: 'script-src', sources: ['https://challenges.cloudflare.com'] },
      { directive: 'frame-src', sources: ['https://challenges.cloudflare.com'] },
    ],
  }),
}
