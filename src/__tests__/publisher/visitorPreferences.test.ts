import { describe, expect, it } from 'bun:test'
import { publishPage, renderNode } from '@core/publisher'
import { ModulePropsValidationError, ModulePublishValidationError, validateModulePublishInput } from '@core/module-engine'
import { Type } from '@core/utils/typeboxHelpers'
import { DEFAULT_SITE_VISITOR_PREFERENCES } from '@core/visitor-preferences-schema'
import { VISITOR_PREFERENCES_RUNTIME_PATH } from '@core/visitor-preferences'
import { PreferenceModule } from '@modules/base/preference'
import { VideoModule } from '@modules/base/video'
import { BodyModule } from '@modules/base/body'
import { makeAccumulators, makePage, makeRegistry, makeSite } from './helpers'

const registry = makeRegistry({ 'base.body': BodyModule, 'base.preference': PreferenceModule, 'base.video': VideoModule })
const settings = { visitorPreferences: DEFAULT_SITE_VISITOR_PREFERENCES, shortcuts: {} }
const decorative = { playbackRole: 'decorative', videoUrl: '/intro.webm', muted: true, controls: false, playsinline: true, autoplay: true, poster: '/poster.jpg' }

describe('native visitor preferences publishing', () => {
  it('owns an early synchronous asset on every configured document, without visible controls', () => {
    const page = makePage({ root: { moduleId: 'base.body' } })
    const html = publishPage(page, makeSite({ pages: [page], settings }), registry).html
    expect(html).toContain('<script src="' + VISITOR_PREFERENCES_RUNTIME_PATH + '"></script>')
    expect(html.indexOf(VISITOR_PREFERENCES_RUNTIME_PATH)).toBeLessThan(html.indexOf('<style'))
    expect(html).toContain('&quot;storage&quot;:&quot;persistent&quot;')
    expect(html).toContain("script-src 'self'")
    expect(html).toContain('data-instatic-motion="reduced"')
    const plain = publishPage(page, makeSite({ pages: [page] }), registry).html
    expect(plain).not.toContain(VISITOR_PREFERENCES_RUNTIME_PATH)
  })

  it('keeps private previews memory-only and publishes escaped authored captions', () => {
    const page = makePage({ root: { moduleId: 'base.preference', props: { label: '{site.name}', savedStatus: 'Saved & safe <ok>' } } })
    const html = publishPage(page, makeSite({ name: 'My & site', pages: [page], settings }), registry, { visitorPreferencesStorage: 'memory' }).html
    expect(html).toContain('&quot;storage&quot;:&quot;memory&quot;')
    expect(html).toContain('My &amp; site')
    expect(html).toContain('Saved &amp; safe &lt;ok&gt;')
    expect(html).not.toContain('amp;amp;')
    expect(html).toContain('data-instatic-preference-status="session" hidden')
    expect(html).toContain('select data-instatic-preference-value="" disabled')
  })

  it('fails clearly when a control requires missing site defaults', () => {
    const page = makePage({ root: { moduleId: 'base.preference' } })
    expect(() => publishPage(page, makeSite({ pages: [page] }), registry)).toThrow(ModulePublishValidationError)
    try { publishPage(page, makeSite({ pages: [page] }), registry) } catch (error) {
      expect(error).toBeInstanceOf(ModulePublishValidationError)
      expect((error as ModulePublishValidationError).path).toContain('nodes.root/settings/visitorPreferences')
    }
  })

  it('retains the path and cause when a plugin declares an invalid publish schema', () => {
    const definition = { ...PreferenceModule, publishSchema: Type.Ref('missing-schema') }
    try {
      validateModulePublishInput(definition, PreferenceModule.defaults, settings, 'pages.test.nodes.control')
      throw new Error('An invalid publish schema was accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(ModulePublishValidationError)
      expect((error as ModulePublishValidationError).path).toBe('pages.test.nodes.control/publishSchema')
      expect((error as Error).cause).toBeInstanceOf(Error)
    }
  })

  it('does not replace an unresolved authored label or status with a module fallback', () => {
    for (const props of [{ label: '{site.missing}' }, { sessionStatus: '{site.missing}' }, { label: '   ' }, { sessionStatus: '\n\t' }]) {
      const page = makePage({ root: { moduleId: 'base.preference', props } })
      expect(() => publishPage(page, makeSite({ pages: [page], settings }), registry)).toThrow(ModulePublishValidationError)
    }
  })

  it('does not hide malformed required props by restoring an ordinary-video role or English captions', () => {
    for (const input of [
      { moduleId: 'base.video', props: { ...decorative, muted: { invalid: true } } },
      { moduleId: 'base.preference', props: { sessionStatus: { invalid: true } } },
    ]) {
      const page = makePage({ root: input })
      expect(() => publishPage(page, makeSite({ pages: [page], settings }), registry)).toThrow(ModulePropsValidationError)
      try { publishPage(page, makeSite({ pages: [page], settings }), registry) } catch (error) {
        expect(error).toBeInstanceOf(ModulePropsValidationError)
        expect((error as ModulePropsValidationError).path).toContain('nodes.root/props/')
        expect((error as Error).cause).toBeInstanceOf(Error)
      }
    }
  })

  it('withholds decorative download and autoplay at parser time while preserving poster and content video', () => {
    const page = makePage({ root: { moduleId: 'base.body', children: ['background', 'content'] }, background: { moduleId: 'base.video', props: decorative }, content: { moduleId: 'base.video', props: { videoUrl: '/content.webm', controls: true, preload: 'metadata' } } })
    const html = publishPage(page, makeSite({ pages: [page], settings }), registry).html
    document.body.innerHTML = html.slice(html.indexOf('<body>'))
    const background = document.querySelector('video[data-instatic-decorative-src]')!
    expect(background.getAttribute('data-instatic-decorative-src')).toBe('/intro.webm')
    expect(background.getAttribute('data-instatic-decorative-ready')).toBe('false')
    expect(background.hasAttribute('src')).toBe(false)
    expect(background.hasAttribute('autoplay')).toBe(false)
    expect(background.getAttribute('preload')).toBe('none')
    expect(background.getAttribute('poster')).toBe('/poster.jpg')
    const content = document.querySelector('video[src="/content.webm"]')!
    expect(content.hasAttribute('data-instatic-decorative-ready')).toBe(false)
    expect(content.hasAttribute('controls')).toBe(true)
    expect(content.getAttribute('preload')).toBe('metadata')
    document.body.replaceChildren()
  })

  it('validates resolved bindings rather than their editorial fallback, including hole rendering', () => {
    const page = makePage({ root: { moduleId: 'base.video', props: { ...decorative, videoUrl: '' }, dynamicBindings: { videoUrl: { source: 'currentEntry', field: 'movie', fallback: 'static' } } } })
    const site = makeSite({ pages: [page], settings })
    const config = { page, site, registry, templateContext: { entryStack: [{ id: 'row', fields: { movie: '/ordinary-local.webm' } }] } }
    expect(renderNode('root', config, makeAccumulators())).toContain('data-instatic-decorative-src="/ordinary-local.webm"')
    expect(() => renderNode('root', { ...config, templateContext: { entryStack: [{ id: 'row', fields: { movie: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }] } }, makeAccumulators())).toThrow(ModulePublishValidationError)
  })

  it.each([
    { videoUrl: 'https://cdn.example.org/intro.webm' }, { videoUrl: '//elsewhere.example/intro.webm' },
    { videoUrl: '/\\elsewhere.example/intro.webm' }, { videoUrl: '/bad url.webm' },
    { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { muted: false }, { controls: true }, { playsinline: false },
  ])('rejects unsupported decorative playback %j', invalid => {
    const page = makePage({ root: { moduleId: 'base.video', props: { ...decorative, ...invalid } } })
    expect(() => publishPage(page, makeSite({ pages: [page], settings }), registry)).toThrow(ModulePublishValidationError)
  })
})
