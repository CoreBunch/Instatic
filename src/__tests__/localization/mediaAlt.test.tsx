import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import '@modules/base'
import { registry } from '@core/module-engine'
import { publishPage, type RenderResolvedMedia } from '@core/publisher'
import { buildSiteFrame } from '@core/templates/contextFrames'
import { LocalizationError } from '@core/localization'
import { CanvasTemplateContext } from '@admin/pages/site/canvas/CanvasContexts'
import { normalizeCmsMediaAsset } from '@core/persistence/cmsMedia'
import { primeCmsMediaAssetCache, refreshCmsMediaAssetCache } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'

afterEach(() => { cleanup(); refreshCmsMediaAssetCache() })

const src = '/uploads/shared.jpg'
const definition = registry.getOrThrow('base.image')
const token = '{site.translations.media.alt}'
const messages = {
  it: 'Persone & infrastruttura', en: 'People & infrastructure', de: 'Menschen "vor Ort"',
  fr: 'Les personnes <ensemble>', es: 'Personas e infraestructura', nl: 'Mensen en infrastructuur',
  pl: 'Ludzie i infrastruktura', pt: 'Pessoas e infraestrutura', ro: 'Oameni și infrastructură',
}

function fixture(altText = token) {
  const files = Object.entries(messages).map(([language, alt]) => ({
    id: language, path: `locales/${language}.json`, type: 'config' as const,
    content: JSON.stringify({ language, messages: { media: { alt } } }), createdAt: 0, updatedAt: 0,
  }))
  const image = makeNode({ id: 'image', moduleId: 'base.image', props: { ...definition.defaults, src } })
  const component = makeVC({ id: 'shared', tree: makeVCTree('body', [
    makeNode({ id: 'body', moduleId: 'base.body', children: ['image'] }), image,
  ]) })
  const page = makePage({ language: 'it', nodes: {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ref'] }),
    ref: makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: 'shared' } }),
  } })
  const site = makeSite({ pages: [page], visualComponents: [component], files, settings: {
    shortcuts: {}, language: 'it', localization: { catalogues: files.map(file => ({ language: file.id, fileId: file.id })) },
  } })
  const asset: RenderResolvedMedia = { publicPath: src, mimeType: 'image/jpeg', width: 100, height: 100, altText, blurHash: null, variants: [], posterPath: null }
  primeCmsMediaAssetCache(normalizeCmsMediaAsset({ id: 'shared', filename: 'shared.jpg', mimeType: 'image/jpeg', publicPath: src, sizeBytes: 1, uploadedByUserId: null, createdAt: '', altText }))
  return { site, page, image, asset, mediaAssets: new Map([[src, asset]]) }
}

describe('Media Library localized alt text', () => {
  it('renders one shared image in nine languages in the canvas and publisher, preserving authored metadata', () => {
    const { site, page, image, mediaAssets, asset } = fixture()
    for (const [language, alt] of Object.entries(messages)) {
      const localizedPage = { ...page, language }
      const html = publishPage(localizedPage, site, registry, { mediaAssets }).html
      const wrapper = document.createElement('div')
      wrapper.innerHTML = html
      const canvas = render(<CanvasTemplateContext.Provider value={{ entryStack: [], site: buildSiteFrame(site, language) }}>
        {React.createElement(definition.component, { nodeId: image.id, isSelected: false, props: image.props })}
      </CanvasTemplateContext.Provider>)
      expect(wrapper.querySelector('img')?.getAttribute('alt')).toBe(alt)
      expect(canvas.container.querySelector('img')?.getAttribute('alt')).toBe(alt)
      expect(html).not.toContain(token)
      expect(html).not.toContain('locales/')
      expect(mediaAssets.get(src)).toBe(asset)
      expect(asset.altText).toBe(token)
      canvas.unmount()
    }
    expect(image.props).not.toHaveProperty('alt')
  })

  it.each(['', 'Literal & "quoted" <text>'])('keeps decorative and literal metadata unchanged: %s', (alt) => {
    const { site, page, mediaAssets } = fixture(alt)
    const wrapper = document.createElement('div')
    wrapper.innerHTML = publishPage(page, site, registry, { mediaAssets }).html
    expect(wrapper.querySelector('img')?.getAttribute('alt')).toBe(alt)
  })

  it('rejects a missing library translation instead of leaking the token or substituting another language', () => {
    const { site, page, mediaAssets } = fixture('{site.translations.media.missing}')
    expect(() => publishPage(page, site, registry, { mediaAssets })).toThrow(LocalizationError)
  })
})
