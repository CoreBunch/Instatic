import { describe, test, expect } from 'bun:test'
import { publishPage } from '@core/publisher'
import { makeModule, makeRegistry, makePage, makeSite } from './helpers'

/**
 * ISS-007: the inline-CSS emitter baked the raw user stylesheet + framework CSS
 * into a `<style>` block without `</style>` neutralisation. A user stylesheet
 * containing `</style><script>…` could close the style element early and inject
 * script into the rendered page (stored XSS, e.g. in the admin Live Canvas
 * iframe). Every inline CSS source must be neutralised before emission.
 */
describe('inline CSS emission — </style> breakout (ISS-007)', () => {
  test('neutralises </style> from a user stylesheet', () => {
    const registry = makeRegistry({
      'base.text': makeModule('base.text', {
        assets: { css: '' },
        render: (props) => ({ html: `<h1>${(props as { text: string }).text}</h1>` }),
      }),
    })
    const site = makeSite({
      files: [
        {
          id: 'evil',
          path: 'styles/evil.css',
          type: 'style',
          content: 'h1{color:red}</style><script>alert(document.cookie)</script>',
        },
      ],
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)

    // The breakout sequence must not survive verbatim — it would close the
    // <style> element and run the script.
    expect(html).not.toContain('</style><script>')
    // The CSS itself is still present (neutralised, not dropped).
    expect(html).toContain('h1{color:red}')
  })
})
