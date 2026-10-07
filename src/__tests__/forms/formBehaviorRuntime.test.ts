import { describe, expect, it } from 'bun:test'
import { Window } from 'happy-dom'
import { FormModule, InputModule, SelectModule, OptionModule, FormMessageModule, FormConditionalModule, FormOutputModule, TurnstileModule } from '@modules/base/forms'
import { escapeProps } from '@core/publisher'
import { installFormRuntime } from '@modules/base/forms/runtime'
import { FORM_RUNTIME_JS } from '@modules/base/forms/formRuntimeJs'

function input(name: string, extra: Record<string, unknown> = {}) {
  const props = { ...InputModule.defaults, name, ...extra }
  return InputModule.render(escapeProps(props, InputModule.schema) as typeof props, []).html
}
function select() {
  return SelectModule.render({ ...SelectModule.defaults, name: 'purpose', queryParameter: 'kind' }, [
    OptionModule.render({ ...OptionModule.defaults, value: 'basic', label: 'Basic' }, []).html,
    OptionModule.render({ ...OptionModule.defaults, value: 'advanced', label: 'Advanced' }, []).html,
  ]).html
}
function message(kind: 'status' | 'success' | 'error', source: 'state' | 'authored' | 'response' = 'state', text = '') {
  return FormMessageModule.render(escapeProps({ ...FormMessageModule.defaults, kind, source, text }, FormMessageModule.schema) as typeof FormMessageModule.defaults, []).html
}
async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) }
function setup(children: string[], props: Record<string, unknown> = {}, url = 'https://site.example/contact') {
  const realm = new Window({ url, settings: { disableJavaScriptFileLoading: true } })
  realm.document.body.innerHTML = FormModule.render({ ...FormModule.defaults, mode: 'request', action: 'https://recipient.example/form', pendingMessage: 'Attendi', successMessage: 'Ricevuto', errorMessage: 'Errore invio', invalidMessage: 'Controlla i campi', captchaMessage: 'Completa la verifica', unavailableMessage: 'Modulo non disponibile', ...props }, children).html
  const browser = realm as unknown as globalThis.Window & typeof globalThis
  const form = browser.document.querySelector('form')!
  function send() { form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })) }
  function change(name: string, value: string) {
    const control = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement
    control.value = value
    control.dispatchEvent(new browser.Event('change', { bubbles: true }))
  }
  return { realm, browser, form, send, change }
}

describe('native form browser model', () => {
  it('initializes an offered query choice, conditions, requiredness, mirrors and plain-text outputs', async () => {
    const group = FormConditionalModule.render({ condition: { field: 'purpose', eq: 'advanced' } }, [input('details', { requiredWhen: { field: 'purpose', eq: 'advanced' } })]).html
    const view = setup([select(), group, input('mirror', { inputType: 'hidden', valueSourceField: 'purpose' }), FormOutputModule.render({ fieldName: 'purpose', text: '' }, []).html], {}, 'https://site.example/contact?kind=advanced')
    try {
      installFormRuntime(view.browser)
      expect((view.form.elements.namedItem('purpose') as HTMLSelectElement).value).toBe('advanced')
      expect((view.form.elements.namedItem('details') as HTMLInputElement).required).toBe(true)
      expect(view.form.querySelector<HTMLElement>('[data-instatic-form-condition]')!.hidden).toBe(false)
      expect((view.form.elements.namedItem('mirror') as HTMLInputElement).value).toBe('advanced')
      expect(view.form.querySelector('output')!.textContent).toBe('advanced')
      view.change('purpose', 'basic')
      expect((view.form.elements.namedItem('details') as HTMLInputElement).disabled).toBe(true)
      expect((view.form.elements.namedItem('details') as HTMLInputElement).required).toBe(false)
      expect(view.form.querySelector<HTMLElement>('[data-instatic-form-condition]')!.hidden).toBe(true)
      expect((view.form.elements.namedItem('mirror') as HTMLInputElement).value).toBe('basic')
      view.form.reset(); await flush()
      expect((view.form.elements.namedItem('purpose') as HTMLSelectElement).value).toBe('advanced')
    } finally { await view.realm.happyDOM.close() }
  })

  it('rejects unknown query options and values exceeding authored limits', async () => {
    const view = setup([select(), input('topic', { queryParameter: 'topic', maxLength: 5, value: 'short' })], {}, 'https://site.example/contact?kind=forged&topic=too-long')
    try {
      installFormRuntime(view.browser)
      expect((view.form.elements.namedItem('purpose') as HTMLSelectElement).value).toBe('basic')
      expect((view.form.elements.namedItem('topic') as HTMLInputElement).value).toBe('short')
      expect(view.form.getAttribute('data-instatic-form-state')).toBe('invalid')
      expect((view.form.elements.namedItem('purpose') as HTMLSelectElement).validationMessage).toBe('Controlla i campi')
      view.change('purpose', 'advanced'); view.change('topic', 'valid')
      expect(view.form.checkValidity()).toBe(true)
    } finally { await view.realm.happyDOM.close() }
  })

  it('rejects browser-sanitized query values and keeps an empty conditional required value editable', async () => {
    const view = setup([select(), input('amount', { inputType: 'number', queryParameter: 'amount', value: '12' }), input('details', { queryParameter: 'details', lockQueryValue: true, requiredWhen: { field: 'purpose', eq: 'advanced' } })], {}, 'https://site.example/contact?kind=advanced&amount=invalid&details=')
    try {
      installFormRuntime(view.browser)
      expect((view.form.elements.namedItem('amount') as HTMLInputElement).value).toBe('12')
      expect(view.form.getAttribute('data-instatic-form-state')).toBe('invalid')
      expect((view.form.elements.namedItem('details') as HTMLInputElement).readOnly).toBe(false)
      expect((view.form.elements.namedItem('details') as HTMLInputElement).required).toBe(true)
      view.change('amount', '20'); view.change('details', 'Required detail')
      expect(view.form.checkValidity()).toBe(true)
    } finally { await view.realm.happyDOM.close() }
  })

  it('locks only a valid declared query value while preserving HTML submission and reset', async () => {
    const lockedSelect = SelectModule.render({ ...SelectModule.defaults, name: 'purpose', queryParameter: 'kind', lockQueryValue: true }, [
      OptionModule.render({ ...OptionModule.defaults, value: 'basic', label: 'Basic' }, []).html,
      OptionModule.render({ ...OptionModule.defaults, value: 'advanced', label: 'Advanced' }, []).html,
    ]).html
    const view = setup([lockedSelect, input('topic', { queryParameter: 'topic', lockQueryValue: true })], {}, 'https://site.example/contact?kind=advanced&topic=Known')
    try {
      installFormRuntime(view.browser)
      const control = view.form.elements.namedItem('purpose') as HTMLSelectElement
      expect(control.disabled).toBe(false)
      expect(Array.from(control.options, (option) => option.disabled)).toEqual([true, false])
      expect((view.form.elements.namedItem('topic') as HTMLInputElement).readOnly).toBe(true)
      expect(new view.browser.FormData(view.form).get('purpose')).toBe('advanced')
      view.form.reset(); await flush()
      expect(control.value).toBe('advanced')
      expect(new view.browser.FormData(view.form).get('topic')).toBe('Known')
    } finally { await view.realm.happyDOM.close() }
  })

  it('surfaces corrupt declarative DOM conditions through authored unavailable copy', async () => {
    const view = setup([input('name'), message('error')])
    view.form.querySelector('input')!.setAttribute('data-instatic-required-when', '{broken')
    let calls = 0
    view.browser.fetch = async () => { calls++; return new Response('{"ok":true}') }
    try {
      expect(() => installFormRuntime(view.browser)).not.toThrow()
      view.send(); await flush()
      expect(calls).toBe(0)
      expect(view.form.getAttribute('data-instatic-form-state')).toBe('unavailable')
      expect(view.form.querySelector('[data-instatic-form-message]')!.textContent).toBe('Modulo non disponibile')
    } finally { await view.realm.happyDOM.close() }
  })

  it('retries a failed CAPTCHA loader and renders one widget before checking its token', async () => {
    const widget = TurnstileModule.render({ ...TurnstileModule.defaults, siteKey: 'public-key' }, []).html
    const view = setup([widget, input('name'), message('error')])
    let renders = 0, sends = 0
    view.browser.fetch = async () => { sends++; return new Response('{"ok":true}') }
    try {
      installFormRuntime(view.browser)
      view.browser.document.querySelector('script')!.dispatchEvent(new view.browser.Event('error'))
      await flush()
      expect(view.form.getAttribute('data-instatic-form-state')).toBe('captcha')
      Object.assign(view.browser, { turnstile: { render: () => { renders++; return 'widget' }, reset: () => {}, getResponse: () => 'verified' } })
      view.send(); await flush()
      expect(renders).toBe(1)
      expect(sends).toBe(1)
    } finally { await view.realm.happyDOM.close() }
  })

  it('prevents duplicate external submissions while the verification provider is loading', async () => {
    const widget = TurnstileModule.render({ ...TurnstileModule.defaults, siteKey: 'public-key' }, []).html
    const view = setup([widget, input('name'), message('error')])
    let sends = 0
    view.browser.fetch = async () => { sends++; return new Response('{"ok":true}') }
    let loader: HTMLScriptElement | undefined
    view.browser.document.head.append = (...nodes) => {
      const node = nodes[0]
      if (node instanceof view.browser.HTMLScriptElement) loader = node
    }
    try {
      installFormRuntime(view.browser)
      view.send(); view.send()
      Object.assign(view.browser, { turnstile: { render: () => 'widget', reset: () => {}, getResponse: () => 'verified' } })
      if (!loader) throw new Error('Missing controlled loader')
      loader.dispatchEvent(new view.browser.Event('load'))
      await flush()
      expect(sends).toBe(1)
      expect(view.form.getAttribute('aria-busy')).toBe('false')
    } finally { await view.realm.happyDOM.close() }
  })

  it('uses authored validation/state copy and sends no invalid request', async () => {
    const view = setup([input('email', { inputType: 'email', required: true, requiredMessage: 'Inserisci email', invalidMessage: 'Email non valida' }), message('error')])
    let calls = 0
    view.browser.fetch = async () => { calls++; return new Response('{"ok":true}') }
    try {
      installFormRuntime(view.browser); view.send(); await flush()
      expect(calls).toBe(0)
      expect(view.form.getAttribute('data-instatic-form-state')).toBe('invalid')
      expect(view.form.querySelector('[data-instatic-form-message]')!.textContent).toBe('Controlla i campi')
      expect((view.form.elements.namedItem('email') as HTMLInputElement).validationMessage).toBe('Inserisci email')
    } finally { await view.realm.happyDOM.close() }
  })

  it.each(['multipart','json'])('sends declared %s requests and preserves authored headings separately from response text', async (encoding) => {
    const view = setup([input('email', { value: 'visitor@example.com' }), '<button type="submit">Send</button>', message('status'), message('success', 'authored', 'Titolo fisso'), message('success', 'response'), message('success')], { encoding, resetOnSuccess: false })
    const calls: RequestInit[] = []
    view.browser.fetch = async (_path, init) => { calls.push(init!); return new Response(JSON.stringify({ ok: true, message: '<img src=x onerror=alert(1)>' })) }
    try {
      installFormRuntime(view.browser); view.send(); await flush()
      expect(calls).toHaveLength(1)
      expect(calls[0].credentials).toBe('omit')
      if (encoding === 'json') expect(JSON.parse(String(calls[0].body))).toEqual({ email: 'visitor@example.com' })
      else expect((calls[0].body as FormData).get('email')).toBe('visitor@example.com')
      const [heading, response, state] = view.form.querySelectorAll('[data-instatic-form-message="success"]')
      expect(heading.textContent).toBe('Titolo fisso')
      expect(response.textContent).toBe('<img src=x onerror=alert(1)>')
      expect(response.querySelector('img')).toBeNull()
      expect(state.textContent).toBe('Ricevuto')
      expect(view.form.getAttribute('aria-busy')).toBe('false')
      expect(view.form.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
    } finally { await view.realm.happyDOM.close() }
  })

  it.each(['{"ok":"true"}','not-json','{"message":"missing success"}'])('rejects malformed declared responses without inventing translated fallback: %s', async (body) => {
    const view = setup([input('name'), message('error')])
    view.browser.fetch = async () => new Response(body)
    try {
      installFormRuntime(view.browser); view.send(); await flush()
      expect(view.form.getAttribute('data-instatic-form-state')).toBe('error')
      expect(view.form.querySelector('[data-instatic-form-message]')!.textContent).toBe('Errore invio')
    } finally { await view.realm.happyDOM.close() }
  })

  it('prefetches and consumes native CMS challenges, then localizes server validation codes', async () => {
    const view = setup([input('email', { fieldId: 'email', value: 'valid@example.com', invalidMessage: 'Correggi email' }), message('error')], { mode: 'cms' })
    view.form.setAttribute('data-instatic-page-id','page'); view.form.setAttribute('data-instatic-page-token','page-token')
    const calls: string[] = []
    view.browser.fetch = async (path) => {
      calls.push(String(path))
      return String(path).endsWith('/challenge') ? new Response(JSON.stringify({ token: 'signed', challenge: 'challenge', expiresAt: '2099-01-01T00:00:00Z' }))
        : new Response(JSON.stringify({ error: 'English server diagnostic', errors: [{ fieldId: 'email', code: 'invalid_email', message: 'English diagnostic' }] }), { status: 400 })
    }
    try {
      installFormRuntime(view.browser); await flush()
      expect(calls).toEqual(['/_instatic/form/challenge'])
      view.send(); await flush()
      expect(calls).toContain('/_instatic/form/submit')
      expect(view.form.getAttribute('data-instatic-form-state')).toBe('invalid')
      expect(view.form.querySelector('[data-instatic-form-message]')!.textContent).toBe('Controlla i campi')
      expect((view.form.elements.namedItem('email') as HTMLInputElement).validationMessage).toBe('Correggi email')
    } finally { await view.realm.happyDOM.close() }
  })

  it('requires a verified-widget token, handles expiration and resets after an external response', async () => {
    const widget = TurnstileModule.render({ ...TurnstileModule.defaults, siteKey: 'public-key', language: 'it' }, []).html
    const view = setup([widget, input('name'), message('error')])
    let token = '', resets = 0, sends = 0
    let options: Record<string, unknown> = {}
    Object.assign(view.browser, { turnstile: {
      render: (_container: unknown, value: Record<string, unknown>) => { options = value; return 'widget' },
      reset: () => { resets++ }, getResponse: () => token,
    } })
    view.browser.fetch = async () => { sends++; return new Response('{"ok":true}') }
    try {
      installFormRuntime(view.browser); await flush(); view.send(); await flush()
      expect(sends).toBe(0); expect(view.form.getAttribute('data-instatic-form-state')).toBe('captcha')
      expect(options.language).toBe('it'); expect(options.sitekey).toBe('public-key')
      const expired = options['expired-callback']; if (typeof expired !== 'function') throw new Error('Missing callback'); expired()
      expect(resets).toBe(1)
      token = 'verified-token'; view.send(); await flush()
      expect(sends).toBe(1); expect(resets).toBe(2)
    } finally { await view.realm.happyDOM.close() }
  })

  it('leaves ordinary HTML action forms unenhanced even beside an enhanced form', async () => {
    const view = setup([input('name')])
    view.browser.document.body.insertAdjacentHTML('beforeend', FormModule.render({ ...FormModule.defaults, mode: 'custom' }, []).html)
    try {
      installFormRuntime(view.browser)
      const ordinary = view.browser.document.querySelectorAll('form')[1]
      const event = new view.browser.Event('submit', { bubbles: true, cancelable: true })
      ordinary.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    } finally { await view.realm.happyDOM.close() }
  })

  it('runs the emitted standalone asset with query conditions, native button validation and submitter data', async () => {
    const group = FormConditionalModule.render({ condition: { field: 'purpose', eq: 'advanced' } }, [input('details', { requiredWhen: { field: 'purpose', eq: 'advanced' } })]).html
    const view = setup([select(), group, '<button type="submit" name="intent" value="send">Send</button>', message('error'), message('success')], { resetOnSuccess: false }, 'https://site.example/contact?kind=advanced')
    const requests: FormData[] = []
    view.browser.fetch = async (_path, options) => { requests.push(options!.body as FormData); return new Response('{"ok":true}') }
    try {
      view.realm.eval(FORM_RUNTIME_JS)
      const button = view.form.querySelector<HTMLButtonElement>('button')!
      view.form.requestSubmit(button); await flush()
      expect(requests).toHaveLength(0)
      expect(view.form.getAttribute('data-instatic-form-state')).toBe('invalid')
      view.change('details', 'Visitor detail')
      view.form.requestSubmit(button); await flush()
      expect(requests).toHaveLength(1)
      expect(requests[0].get('purpose')).toBe('advanced')
      expect(requests[0].get('intent')).toBe('send')
      expect(view.form.querySelector('[data-instatic-form-message="success"]')!.textContent).toBe('Ricevuto')
    } finally { await view.realm.happyDOM.close() }
  })

  it('ships a compact native runtime with generated TypeBox checks and no translation catalogue or compiler', () => {
    expect(FORM_RUNTIME_JS.length).toBeLessThan(20000)
    expect(FORM_RUNTIME_JS).not.toMatch(/\beval\s*\(|new Function\s*\(/)
    expect(FORM_RUNTIME_JS).not.toContain('Thanks. Your submission was received.')
    expect(FORM_RUNTIME_JS).not.toContain('locales/')
    expect(FORM_RUNTIME_JS).not.toContain('data-netsons')
  })
})
