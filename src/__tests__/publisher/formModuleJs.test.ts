import { describe, expect, it } from 'bun:test'
import { FormModule } from '../../modules/base/forms'
import { FORM_RUNTIME_JS } from '../../modules/base/forms/formRuntimeJs'

describe('base.form module-JS emission', () => {
  it('emits the form runtime as js when mode is cms', () => {
    const out = FormModule.render({ ...FormModule.defaults, mode: 'cms' }, [])
    expect(out.js).toBe(FORM_RUNTIME_JS)
    expect(out.html).toContain('data-instatic-form-mode="cms"')
  })

  it('emits no js when mode is custom', () => {
    const out = FormModule.render({ ...FormModule.defaults, mode: 'custom' }, [])
    expect(out.js).toBeUndefined()
  })

  it('runtime binds via document-level delegation and reads pageId per form', () => {
    expect(FORM_RUNTIME_JS).toContain('addEventListener("submit"')
    expect(FORM_RUNTIME_JS).toContain('page-id')
    expect(FORM_RUNTIME_JS).toContain('/_instatic/form/challenge')
    expect(FORM_RUNTIME_JS).toContain('/_instatic/form/submit')
  })
})

describe('declared form resources', () => {
  it('emits one root runtime for request/enhanced HTML transports with precise resource declarations', () => {
    const request = FormModule.render({ ...FormModule.defaults, mode: 'request', action: 'https://recipient.example/submit' }, [])
    expect(request.js).toBe(FORM_RUNTIME_JS)
    expect(request.cspSources).toEqual([
      { directive: 'connect-src', sources: ['https://recipient.example'] },
      { directive: 'form-action', sources: ['https://recipient.example'] },
    ])
    const html = FormModule.render({ ...FormModule.defaults, mode: 'custom', action: 'https://recipient.example/submit', enhance: true }, [])
    expect(html.js).toBe(FORM_RUNTIME_JS)
    expect(html.cspSources).toEqual([{ directive: 'form-action', sources: ['https://recipient.example'] }])
    expect(FormModule.render(FormModule.defaults, []).cspSources).toBeUndefined()
  })
})
