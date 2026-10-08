import type { Static } from '@sinclair/typebox'
import type { PropertyCondition } from '@core/module-engine-schema'
import { evaluateCondition } from '@core/value-conditions'
import type { FormTransport, FormChallengeResponse, FormValidationResponseSchema, TurnstileApi } from '@core/forms-schema'
import { checkCondition, checkTransport, checkControl, checkChallenge, checkJsonResponse, checkTurnstileConfiguration, checkTurnstileApi, checkValidationResponse, checkSuccessResponse, checkResponseContract } from './runtimeValidators.js'

const FORM_SELECTOR = 'form[data-instatic-form-id][data-instatic-form-mode="cms"], form[data-instatic-form-id][data-instatic-form-mode="request"], form[data-instatic-form-id][data-instatic-form-mode="custom"][data-instatic-form-enhanced="true"]'
const CONTROL_SELECTOR = '[data-instatic-form-control]'
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
type ControlValue = { value: string; checked?: boolean; options?: boolean[]; queryError: boolean }
type State = 'idle' | 'pending' | 'success' | 'error' | 'invalid' | 'captcha' | 'unavailable'
class SubmissionError extends Error {
  readonly state: State
  readonly errors?: Static<typeof FormValidationResponseSchema>['errors']
  constructor(state: State, errors?: Static<typeof FormValidationResponseSchema>['errors']) { super('Native form submission failed'); this.state = state; this.errors = errors }
}
type FormState = {
  transport: FormTransport; challenge?: FormChallengeResponse; challengeRequest?: Promise<FormChallengeResponse>
  busy: boolean; buttons: Map<HTMLButtonElement | HTMLInputElement, boolean>; widgets: Map<HTMLElement, string>
  widgetRequest?: Promise<void>
  queryErrors: Set<Control>
  initialValues: Map<Control, ControlValue>
}

/** The only browser behavior for native forms. All user-visible copy is authored HTML. */
export function installFormRuntime(browser: Window & typeof globalThis) {
  const document = browser.document
  if (document.documentElement.hasAttribute('data-instatic-form-runtime')) return
  document.documentElement.setAttribute('data-instatic-form-runtime', '')
  const attached = new WeakMap<HTMLFormElement, FormState>()
  const htmlSubmitReady = new WeakSet<HTMLFormElement>()
  const managedResets = new WeakSet<HTMLFormElement>()
  let providerRequest: Promise<TurnstileApi> | undefined

  function controls(form: HTMLFormElement): Control[] {
    return Array.from(form.querySelectorAll(CONTROL_SELECTOR)).filter((element): element is Control =>
      element instanceof browser.HTMLInputElement || element instanceof browser.HTMLTextAreaElement || element instanceof browser.HTMLSelectElement)
  }
  function isForm(element: EventTarget | null): element is HTMLFormElement {
    return element instanceof browser.HTMLFormElement && element.matches(FORM_SELECTOR)
  }
  function data(element: HTMLElement, key: string) { return element.getAttribute(`data-instatic-${key}`) ?? '' }
  function messages(form: HTMLFormElement) {
    const id = data(form, 'form-id')
    return Array.from(document.querySelectorAll<HTMLElement>('[data-instatic-form-message]'))
      .filter((message) => form.contains(message) || data(message, 'form-id') === id)
  }
  function state(form: HTMLFormElement, next: State, response = '') {
    form.setAttribute('data-instatic-form-state', next)
    const kind = next === 'success' ? 'success' : next === 'pending' || next === 'idle' ? 'status' : 'error'
    const copy = next === 'idle' ? '' : data(form, `${next === 'success' ? 'success' : next}-message`)
    for (const message of messages(form)) {
      const visible = next !== 'idle' && data(message, 'form-message') === kind
      const source = data(message, 'message-source')
      if (source === 'response') message.textContent = response
      else if (source !== 'authored') message.textContent = copy
      message.hidden = !visible || !message.textContent
    }
  }
  function busy(form: HTMLFormElement, value: boolean) {
    const current = attached.get(form)
    if (!current) return
    current.busy = value
    form.setAttribute('aria-busy', String(value))
    if (value) {
      for (const button of form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[type="submit"], input[type="button"]')) {
        current.buttons.set(button, button.disabled)
        button.disabled = true
      }
    } else {
      for (const [button, disabled] of current.buttons) button.disabled = disabled
      current.buttons.clear()
    }
  }
  function values(form: HTMLFormElement): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null)
    for (const control of controls(form)) {
      if (!control.name || control.disabled) continue
      if (control instanceof browser.HTMLInputElement && ['radio', 'checkbox'].includes(control.type) && !control.checked) continue
      const value = control instanceof browser.HTMLSelectElement && control.multiple
        ? Array.from(control.selectedOptions, (option) => option.value) : control.value
      result[control.name] = value
    }
    return result
  }
  function condition(element: HTMLElement, name: string): PropertyCondition | null {
    const raw = data(element, name)
    if (!raw || raw === 'null') return null
    const parsed: unknown = JSON.parse(raw)
    if (!checkCondition(parsed)) throw new Error('Invalid native form condition')
    return parsed
  }
  function update(form: HTMLFormElement) {
    // Selectors must be unconditional: the authoring preflight rejects cycles.
    const currentValues = values(form)
    for (const group of form.querySelectorAll<HTMLElement>('[data-instatic-form-condition]')) {
      const rule = condition(group, 'form-condition')
      group.hidden = rule !== null && !evaluateCondition(rule, currentValues)
    }
    for (const control of controls(form)) {
      const rule = condition(control, 'required-when')
      let active = true
      for (let parent = control.parentElement; parent && parent !== form; parent = parent.parentElement) {
        if (parent.hasAttribute('data-instatic-form-condition') && parent.hidden) active = false
      }
      control.disabled = data(control, 'disabled') === 'true' || !active
      control.required = active && (rule ? evaluateCondition(rule, currentValues) : data(control, 'required') === 'true')
      const source = data(control, 'value-source')
      if (source && Object.hasOwn(currentValues, source)) control.value = String(currentValues[source] ?? '')
      control.setCustomValidity('')
      if (!control.disabled && !control.validity.valid) {
        const message = data(control, control.validity.valueMissing ? 'required-message' : 'invalid-message')
        if (message) control.setCustomValidity(message)
      }
    }
    const updated = values(form)
    for (const output of form.querySelectorAll<HTMLOutputElement>('[data-instatic-form-output]')) {
      output.textContent = String(updated[data(output, 'form-output')] ?? '')
    }
    for (const control of attached.get(form)?.queryErrors ?? []) control.setCustomValidity(data(control, 'invalid-message') || data(form, 'invalid-message'))
  }
  function initialize(form: HTMLFormElement) {
    const current = attached.get(form)
    if (!current) return false
    current.queryErrors.clear()
    const query = new URL(browser.location.href).searchParams
    const initialized = new Set<Control>()
    for (const control of controls(form)) {
      const parameter = data(control, 'query-parameter')
      const initial = parameter ? query.get(parameter) : null
      if (initial === null) continue
      if (initial.length > (control instanceof browser.HTMLSelectElement ? 10000 : control.maxLength > 0 ? control.maxLength : 10000)) { current.queryErrors.add(control); continue }
      if (control instanceof browser.HTMLSelectElement) {
        const option = Array.from(control.options).find((entry) => entry.value === initial && !entry.disabled && !(entry.parentElement instanceof browser.HTMLOptGroupElement && entry.parentElement.disabled))
        if (!option) { current.queryErrors.add(control); continue }
        control.value = option.value
      } else if (!(control instanceof browser.HTMLInputElement) || !['file', 'radio', 'checkbox'].includes(control.type)) {
        const previous = control.value
        control.setCustomValidity('')
        control.value = initial
        if (control.value !== initial || (!control.validity.valid && !control.validity.valueMissing)) { control.value = previous; current.queryErrors.add(control); continue }
      }
      initialized.add(control)

    }
    update(form)
    for (const control of initialized) {
      if (control.disabled) continue
      if (!control.validity.valid) { current.queryErrors.add(control); continue }
      if (data(control, 'query-lock') === 'true') {
        if (control instanceof browser.HTMLSelectElement) {
          for (const option of control.options) option.disabled = option.value !== control.value || option.disabled
        } else {
          control.readOnly = true
        }
      }
    }
    if (current.queryErrors.size) update(form)
    return current.queryErrors.size === 0
  }
  function refresh(form: HTMLFormElement) {
    try { update(form); return true }
    catch { state(form, 'unavailable'); return false }
  }
  function captureValue(control: Control, current: FormState): ControlValue {
    return { value: control.value, queryError: current.queryErrors.has(control),
      ...(control instanceof browser.HTMLInputElement && ['checkbox', 'radio'].includes(control.type) ? { checked: control.checked } : {}),
      ...(control instanceof browser.HTMLSelectElement ? { options: Array.from(control.options, (option) => option.selected) } : {}),
    }
  }
  function restoreValue(control: Control, value: ControlValue) {
    if (control instanceof browser.HTMLSelectElement && value.options) {
      for (const [index, option] of Array.from(control.options).entries()) option.selected = value.options[index] ?? false
      if (!value.options.some(Boolean)) control.selectedIndex = -1
    } else if (control instanceof browser.HTMLInputElement && ['checkbox', 'radio'].includes(control.type) && value.checked !== undefined) control.checked = value.checked
    else if (!(control instanceof browser.HTMLInputElement && control.type === 'file')) control.value = value.value
  }
  function resetValues(form: HTMLFormElement, current: FormState, preserved: Map<Control, ControlValue>) {
    current.queryErrors.clear()
    for (const control of controls(form)) {
      const behavior = data(control, 'reset-behavior')
      const value = behavior === 'preserve' ? preserved.get(control) : behavior === 'clear' ? { value: '', checked: false, options: [], queryError: false } : current.initialValues.get(control)
      if (value) { restoreValue(control, value); if (value.queryError) current.queryErrors.add(control) }
      control.setCustomValidity('')
    }
    // Initial values and locks are captured once; a changed URL never changes reset semantics.
    update(form)
  }
  function labels(form: HTMLFormElement) {
    const ordered = Array.from(form.querySelectorAll<HTMLElement>('label[data-instatic-label-target="auto"], input:not([type="hidden"]):not([data-instatic-honeypot]), textarea, select'))
    let counter = 0
    for (const [index, label] of ordered.entries()) {
      if (label.tagName !== 'LABEL') continue
      const control = ordered.slice(index + 1).find((element) => element.tagName !== 'LABEL')
      if (!control) continue
      if (!control.id) control.id = `instatic-form-${data(form, 'form-id')}-${++counter}`
      label.setAttribute('for', control.id)
    }
  }
  async function readJson(response: Response) {
    const text = await response.text()
    if (text.length > 65536) throw new Error('Native form response is too large')
    const parsed: unknown = JSON.parse(text)
    if (!checkJsonResponse(parsed)) throw new Error('Invalid native form response')
    return parsed
  }
  async function cmsPost(path: string, payload: Record<string, unknown>) {
    const response = await browser.fetch(path, {
      method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload),
      signal: browser.AbortSignal.timeout(20000),
    })
    const body = await readJson(response)
    if (!response.ok) {
      if (checkValidationResponse(body)) throw new SubmissionError('invalid', body.errors)
      throw new SubmissionError('error')
    }
    return body
  }
  function challenge(form: HTMLFormElement): Promise<FormChallengeResponse> {
    const current = attached.get(form)
    if (!current) return Promise.reject(new Error('Native form is not attached'))
    if (current.challenge && Date.now() < Date.parse(current.challenge.expiresAt) - 10000) {
      const result = current.challenge
      current.challenge = undefined
      return Promise.resolve(result)
    }
    if (current.challengeRequest) return current.challengeRequest
    const formId = data(form, 'form-id'), pageId = data(form, 'page-id'), pageToken = data(form, 'page-token')
    if (!formId || !pageId || !pageToken) return Promise.reject(new Error('Missing published form link'))
    const request = cmsPost('/_instatic/form/challenge', { formId, pageId, pageToken }).then((body) => {
      if (!checkChallenge(body) || !Number.isFinite(Date.parse(body.expiresAt))) throw new Error('Invalid form challenge')
      return body
    }).finally(() => { current.challengeRequest = undefined })
    current.challengeRequest = request
    return request
  }
  function prefetch(form: HTMLFormElement) {
    const current = attached.get(form)
    if (!current || current.transport.mode !== 'cms' || current.challenge || current.challengeRequest) return
    void challenge(form).then((result) => { current.challenge = result }, () => { state(form, 'unavailable') })
  }
  function provider(): Promise<TurnstileApi> {
    if ('turnstile' in browser && checkTurnstileApi(browser.turnstile)) return Promise.resolve(browser.turnstile)
    if (providerRequest) return providerRequest
    const script = document.createElement('script')
    providerRequest = new Promise<TurnstileApi>((resolve, reject) => {
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      const timer = browser.setTimeout(() => reject(new Error('Turnstile load timed out')), 20000)
      script.addEventListener('load', () => {
        browser.clearTimeout(timer)
        if ('turnstile' in browser && checkTurnstileApi(browser.turnstile)) resolve(browser.turnstile)
        else reject(new Error('Invalid Turnstile API'))
      }, { once: true })
      script.addEventListener('error', () => { browser.clearTimeout(timer); reject(new Error('Turnstile could not load')) }, { once: true })
      document.head.append(script)
    }).catch((error: unknown) => {
      providerRequest = undefined
      script.remove()
      throw error
    })
    return providerRequest
  }
  function widgets(form: HTMLFormElement): Promise<void> {
    const current = attached.get(form)
    if (!current) return Promise.reject(new Error('Native form is not attached'))
    if (current.widgetRequest) return current.widgetRequest
    const elements = form.querySelectorAll<HTMLElement>('[data-instatic-turnstile]')
    if (!elements.length) return Promise.resolve()
    const request = (async () => {
      const api = await provider()
      for (const element of elements) {
        if (current.widgets.has(element)) continue
        const config = { siteKey: data(element, 'site-key'), action: data(element, 'captcha-action'), language: data(element, 'captcha-language'), theme: data(element, 'captcha-theme'), responseFieldName: data(element, 'captcha-field') }
        if (!checkTurnstileConfiguration(config) || !config.siteKey.trim()) throw new Error('Invalid Turnstile configuration')
        const id = api.render(element, {
          sitekey: config.siteKey, action: config.action, language: config.language, theme: config.theme,
          size: 'flexible', 'response-field': true, 'response-field-name': config.responseFieldName,
          callback: () => { if (!current.busy && data(form, 'form-state') === 'captcha') state(form, 'idle') },
          'expired-callback': () => { state(form, 'captcha'); api.reset(id) },
          'error-callback': () => { state(form, 'captcha') },
          'timeout-callback': () => { state(form, 'captcha') },
        })
        current.widgets.set(element, id)
      }
    })().finally(() => { current.widgetRequest = undefined })
    current.widgetRequest = request
    return request
  }
  function attach(form: HTMLFormElement) {
    if (attached.has(form)) return
    const transport = { mode: data(form, 'form-mode'), action: form.getAttribute('action') ?? '', encoding: data(form, 'encoding'), responseSuccessField: data(form, 'response-success-field'), responseMessageField: data(form, 'response-message-field'), resetOnSuccess: data(form, 'reset-on-success') === 'true' }
    if (!checkTransport(transport)) { state(form, 'unavailable'); return }
    try {
      for (const control of controls(form)) {
        const configuration = { required: data(control, 'required') === 'true', disabled: data(control, 'disabled') === 'true', requiredWhen: condition(control, 'required-when'), queryParameter: data(control, 'query-parameter'), lockQueryValue: data(control, 'query-lock') === 'true', resetBehavior: data(control, 'reset-behavior'), valueSourceField: data(control, 'value-source'), requiredMessage: data(control, 'required-message'), invalidMessage: data(control, 'invalid-message') }
        if (!checkControl(configuration)) throw new Error('Invalid native control configuration')
      }
      attached.set(form, { transport, busy: false, buttons: new Map(), widgets: new Map(), queryErrors: new Set(), initialValues: new Map() })
      // Delegated submission owns validation so state copy is shown even when
      // native requestSubmit would otherwise stop before the submit event.
      form.noValidate = true
      labels(form); state(form, initialize(form) ? 'idle' : 'invalid'); prefetch(form)
      const current = attached.get(form)!
      for (const control of controls(form)) current.initialValues.set(control, captureValue(control, current))
      void widgets(form).catch(() => { state(form, 'captcha') })
    } catch {
      attached.delete(form)
      state(form, 'unavailable')
    }
  }
  function collectValues(formData: FormData) {
    const result: Record<string, unknown> = Object.create(null)
    for (const [name, value] of formData) {
      const normalized = typeof value === 'string' ? value : value.name
      const previous = result[name]
      result[name] = previous === undefined ? normalized : Array.isArray(previous) ? [...previous, normalized] : [previous, normalized]
    }
    return result
  }
  async function submit(form: HTMLFormElement, submitter: HTMLButtonElement | HTMLInputElement | undefined) {
    const current = attached.get(form)
    if (!current || current.busy) return
    if (!refresh(form)) return
    if (!form.checkValidity()) { state(form, 'invalid'); form.reportValidity(); return }
    // Lock the entire asynchronous preparation, including provider loading.
    current.busy = true
    let sent = false
    try {
      if (form.querySelector('[data-instatic-turnstile]')) {
        try {
          await widgets(form)
          const api = await provider()
          if (!current.widgets.size || [...current.widgets.values()].some((id) => !api.getResponse(id))) { state(form, 'captcha'); return }
        } catch { state(form, 'captcha'); return }
      }
      if (current.transport.mode === 'custom') { htmlSubmitReady.add(form); form.requestSubmit(submitter); return }
      const formData = new browser.FormData(form, submitter)
      busy(form, true); state(form, 'pending')
      sent = true
      let responseMessage = ''
      if (current.transport.mode === 'cms') {
        const link = await challenge(form)
        current.challenge = undefined
        const result = await cmsPost('/_instatic/form/submit', { formId: data(form, 'form-id'), pageId: data(form, 'page-id'), token: link.token, challenge: link.challenge, values: collectValues(formData) })
        if (!checkSuccessResponse(result)) throw new SubmissionError('error')
      } else {
        const isJson = current.transport.encoding === 'json'
        const response = await browser.fetch(current.transport.action, {
          method: 'POST', credentials: 'omit', headers: isJson ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
          body: isJson ? JSON.stringify(collectValues(formData)) : formData,
          signal: browser.AbortSignal.timeout(20000),
        })
        const body = await readJson(response)
        if (!checkResponseContract({ success: body[current.transport.responseSuccessField], message: body[current.transport.responseMessageField] })) throw new Error('Invalid declared form response')
        const message = body[current.transport.responseMessageField]
        if (typeof message === 'string') responseMessage = message
        if (!response.ok || body[current.transport.responseSuccessField] !== true) { state(form, 'error', responseMessage); return }
      }
      const redirect = data(form, 'success-redirect')
      if (redirect) { browser.location.assign(redirect); return }
      if (current.transport.resetOnSuccess) {
        const preserved = new Map(controls(form).map((control) => [control, captureValue(control, current)]))
        let resetEvent: Event | undefined
        const capture = (event: Event) => { resetEvent = event }
        form.addEventListener('reset', capture, { once: true })
        managedResets.add(form)
        try { form.reset() } finally { managedResets.delete(form); form.removeEventListener('reset', capture) }
        if (!resetEvent?.defaultPrevented) resetValues(form, current, preserved)
      }
      state(form, 'success', responseMessage)
    } catch (error) {
      if (error instanceof SubmissionError && error.errors) {
        for (const entry of error.errors) {
          const control = controls(form).find((element) => data(element, 'field-id') === entry.fieldId)
          if (control) control.setCustomValidity(data(control, entry.code === 'required' ? 'required-message' : 'invalid-message'))
        }
        form.reportValidity()
      }
      state(form, error instanceof SubmissionError ? error.state : 'error')
    }
    finally {
      busy(form, false)
      if (sent && form.isConnected) {
        prefetch(form)
        if ('turnstile' in browser && checkTurnstileApi(browser.turnstile)) for (const id of current.widgets.values()) browser.turnstile.reset(id)
      }
    }
  }
  for (const form of document.querySelectorAll<HTMLFormElement>(FORM_SELECTOR)) attach(form)
  document.addEventListener('focusin', (event) => {
    const form = event.target instanceof browser.Element ? event.target.closest(FORM_SELECTOR) : null
    if (isForm(form)) attach(form)
  })
  document.addEventListener('input', (event) => {
    const form = event.target instanceof browser.Element ? event.target.closest(FORM_SELECTOR) : null
    if (isForm(form)) { attach(form); if (event.target instanceof browser.HTMLInputElement || event.target instanceof browser.HTMLSelectElement || event.target instanceof browser.HTMLTextAreaElement) attached.get(form)?.queryErrors.delete(event.target); if (attached.has(form) && refresh(form)) state(form, 'idle') }
  })
  document.addEventListener('change', (event) => {
    const form = event.target instanceof browser.Element ? event.target.closest(FORM_SELECTOR) : null
    if (isForm(form)) { attach(form); if (event.target instanceof browser.HTMLInputElement || event.target instanceof browser.HTMLSelectElement || event.target instanceof browser.HTMLTextAreaElement) attached.get(form)?.queryErrors.delete(event.target); if (attached.has(form) && refresh(form)) state(form, 'idle') }
  })
  document.addEventListener('reset', (event) => {
    if (!isForm(event.target) || managedResets.has(event.target)) return
    const form = event.target, current = attached.get(form)
    if (!current) return
    const preserved = new Map(controls(form).map((control) => [control, captureValue(control, current)]))
    queueMicrotask(() => {
      if (event.defaultPrevented) return
      try { resetValues(form, current, preserved); state(form, current.queryErrors.size ? 'invalid' : 'idle') }
      catch { state(form, 'unavailable') }
    })
  })
  document.addEventListener('submit', (event) => {
    if (!isForm(event.target)) return
    if (htmlSubmitReady.delete(event.target)) return
    const submitter = 'submitter' in event && (event.submitter instanceof browser.HTMLButtonElement || event.submitter instanceof browser.HTMLInputElement) ? event.submitter : undefined
    event.preventDefault(); attach(event.target); void submit(event.target, submitter)
  })
}
