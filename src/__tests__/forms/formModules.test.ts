import { describe, expect, it } from 'bun:test'
import {
  CheckboxModule,
  FormMessageModule,
  FormModule,
  InputModule,
  LabelModule,
  OptionGroupModule,
  OptionModule,
  RadioModule,
  SelectModule,
  SubmitModule,
  TextareaModule,
  FormConditionalModule, FormOutputModule, TurnstileModule,
} from '@modules/base/forms'
import { escapeProps } from '@core/publisher'
import { runModuleConformanceSuite } from '../helpers'
import '../matchers'

const FORM_MODULES = [
  FormModule,
  LabelModule,
  InputModule,
  TextareaModule,
  SelectModule,
  OptionModule,
  OptionGroupModule,
  CheckboxModule,
  RadioModule,
  SubmitModule,
  FormMessageModule,
  FormConditionalModule, FormOutputModule, TurnstileModule,
]

for (const mod of FORM_MODULES) {
  runModuleConformanceSuite(mod)
}

describe('base form primitive modules', () => {
  // ISS-027: a control with fieldId set but `name` left blank must still render
  // a `name` attribute (falling back to fieldId) — otherwise the browser's
  // FormData omits the field and the submitted value is silently dropped. The
  // snapshot + validator already key by `name || fieldId`, so render must agree.
  it('falls back to fieldId for the name attribute when name is blank', () => {
    expect(InputModule.render({ ...InputModule.defaults, fieldId: 'email', name: '' }).html)
      .toContain('name="email"')
    expect(TextareaModule.render({ ...TextareaModule.defaults, fieldId: 'bio', name: '' }).html)
      .toContain('name="bio"')
    expect(SelectModule.render({ ...SelectModule.defaults, fieldId: 'country', name: '' }, []).html)
      .toContain('name="country"')
    expect(CheckboxModule.render({ ...CheckboxModule.defaults, fieldId: 'optin', name: '' }, []).html)
      .toContain('name="optin"')
  })

  it('renders a CMS-native form with runtime metadata and children', () => {
    const output = FormModule.render({
      ...FormModule.defaults,
      mode: 'cms',
      formId: 'newsletter',
      targetTableId: 'newsletter_submissions',
      successBehavior: 'message',
      successMessage: 'Thanks',
      redirectUrl: '',
      honeypotName: 'company',
      minSubmitSeconds: 2,
    }, ['<input name="email">'])

    expect(output.html).toContain('<form')
    expect(output.html).toContain('data-instatic-form-id="newsletter"')
    expect(output.html).toContain('data-instatic-form-mode="cms"')
    expect(output.html).toContain('data-instatic-success-message="Thanks"')
    expect(output.html).toContain('<input type="text" name="company"')
    expect(output.html).toContain('<input name="email">')
    expect(output.html).toContain('</form>')
  })

  it('renders labels and text-like controls as semantic HTML', () => {
    expect(LabelModule.render({ ...LabelModule.defaults, text: 'Email', targetMode: 'auto', targetId: '' }, []).html)
      .toBe('<label data-instatic-label-target="auto">Email</label>')

    const input = InputModule.render({
      ...InputModule.defaults,
      inputType: 'email',
      fieldId: 'email',
      name: 'email',
      id: 'email-input',
      placeholder: 'you@example.com',
      value: '',
      required: true,
      disabled: false,
      readOnly: false,
      autocomplete: 'email',
      min: '',
      max: '',
      minLength: 0,
      maxLength: 320,
      pattern: '',
    }, []).html

    expect(input).toContain('<input')
    expect(input).toContain('type="email"')
    expect(input).toContain('data-instatic-form-control="input"')
    expect(input).toContain('data-instatic-field-id="email"')
    expect(input).toContain('name="email"')
    expect(input).toContain('required')
    expect(input).toContain('autocomplete="email"')
  })

  it('renders textarea, select, option, and option-group primitives', () => {
    expect(TextareaModule.render({
      ...TextareaModule.defaults,
      fieldId: 'message',
      name: 'message',
      id: 'message-input',
      placeholder: 'Message',
      value: 'Hello',
      required: false,
      disabled: false,
      readOnly: false,
      rows: 4,
      minLength: 0,
      maxLength: 500,
    }, []).html).toContain('name="message" id="message-input" placeholder="Message" rows="4" maxlength="500"')

    expect(OptionModule.render({ ...OptionModule.defaults, value: 'pro', label: 'Pro', selected: true, disabled: false }, []).html)
      .toBe('<option value="pro" selected>Pro</option>')

    expect(OptionGroupModule.render({ ...OptionGroupModule.defaults, label: 'Plans', disabled: false }, ['<option>Pro</option>']).html)
      .toBe('<optgroup label="Plans"><option>Pro</option></optgroup>')

    expect(SelectModule.render({
      ...SelectModule.defaults,
      fieldId: 'plan',
      name: 'plan',
      id: 'plan-select',
      required: true,
      disabled: false,
      multiple: false,
    }, ['<option value="pro">Pro</option>']).html)
      .toContain('name="plan" id="plan-select" required')
  })

  it('renders choice controls, submit, and form messages', () => {
    expect(CheckboxModule.render({
      ...CheckboxModule.defaults,
      fieldId: 'agree',
      name: 'agree',
      id: 'agree-input',
      value: 'yes',
      checked: true,
      required: true,
      disabled: false,
    }, []).html).toContain('name="agree" id="agree-input" value="yes" checked required')

    expect(RadioModule.render({
      ...RadioModule.defaults,
      fieldId: 'plan',
      name: 'plan',
      id: 'plan-pro',
      value: 'pro',
      checked: false,
      required: false,
      disabled: false,
    }, []).html).toContain('name="plan" id="plan-pro" value="pro"')

    expect(SubmitModule.render({ ...SubmitModule.defaults, label: 'Subscribe', disabled: false, formId: '' }, []).html)
      .toBe('<button type="submit">Subscribe</button>')

    expect(FormMessageModule.render({
      ...FormMessageModule.defaults,
      formId: 'newsletter',
      kind: 'success',
      text: 'Thanks',
    }, []).html).toBe('<div data-instatic-form-message="success" data-instatic-message-source="state" data-instatic-form-id="newsletter" role="status" hidden>Thanks</div>')
  })

  it('escapes authored form text and attributes through the publisher boundary', () => {
    const labelProps = escapeProps({
      ...LabelModule.defaults,
      text: '<b>Email</b>',
      targetMode: 'explicit',
      targetId: 'email" autofocus="true',
    }, LabelModule.schema)
    const labelHtml = LabelModule.render(labelProps, []).html

    expect(labelHtml).toBeCleanHTML()
    expect(labelHtml).toContain('for="email&quot; autofocus=&quot;true"')
    expect(labelHtml).toContain('&lt;b&gt;Email&lt;/b&gt;')
    expect(labelHtml).not.toContain('<b>Email</b>')

    const inputProps = escapeProps({
      ...InputModule.defaults,
      fieldId: 'email',
      name: 'email',
      placeholder: 'Email "address"',
      value: '" autofocus="true',
      pattern: '[^"]+',
    }, InputModule.schema)
    const inputHtml = InputModule.render(inputProps, []).html

    expect(inputHtml).toBeCleanHTML()
    expect(inputHtml).toContain('placeholder="Email &quot;address&quot;"')
    expect(inputHtml).toContain('value="&quot; autofocus=&quot;true"')
    expect(inputHtml).toContain('pattern="[^&quot;]+"')

    const textareaProps = escapeProps({
      ...TextareaModule.defaults,
      fieldId: 'message',
      name: 'message',
      value: '<script>alert(1)</script>',
    }, TextareaModule.schema)
    const textareaHtml = TextareaModule.render(textareaProps, []).html

    expect(textareaHtml).toBeCleanHTML()
    expect(textareaHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(textareaHtml).not.toContain('<script>')
  })

  it('normalizes configured form ids while preserving safe custom-action URLs', () => {
    const formOutput = FormModule.render({
      ...FormModule.defaults,
      ...FormModule.defaults,
      mode: 'custom',
      formId: 'Contact Form!',
      action: 'https://example.com/submit',
      method: 'post',
      successBehavior: 'redirect',
      redirectUrl: 'javascript:alert(1)',
    }, [])

    expect(formOutput.html).toContain('data-instatic-form-id="Contact-Form"')
    expect(formOutput.html).toContain('action="https://example.com/submit"')
    expect(formOutput.html).toContain('data-instatic-success-redirect="#"')
    expect(formOutput.html).not.toContain('javascript:')
    expect(formOutput.js).toBeUndefined()

    expect(SubmitModule.render({ ...SubmitModule.defaults, formId: 'Contact Form!' }, []).html)
      .toBe('<button type="submit" form="Contact-Form">Submit</button>')
    expect(FormMessageModule.render({ ...FormMessageModule.defaults, formId: 'Contact Form!' }, []).html)
      .toContain('data-instatic-form-id="Contact-Form"')
  })
})
