import { describe, expect, it } from 'bun:test'
import { ModulePropsValidationError } from '@core/module-engine'
import { publishPage, renderNode } from '@core/publisher'
import { ImageModule } from '@modules/base/image'
import { TextModule } from '@modules/base/text'
import { LoopModule } from '@modules/base/loop'
import { VisualComponentRefModule } from '@modules/base/visualComponentRef'
import { makeAccumulators, makePage, makeRegistry, makeSite } from './helpers'

const registry = makeRegistry({ 'base.image': ImageModule, 'base.text': TextModule, 'base.loop': LoopModule, 'base.visual-component-ref': VisualComponentRefModule })

describe('publisher hard module-props boundary', () => {
  it('uses declared defaults for missing props', () => {
    const page = makePage({ root: { moduleId: 'base.text' } })
    expect(publishPage(page, makeSite({ pages: [page] }), registry).html).toContain('Add your text here.')
  })

  it('rejects malformed ordinary-module props instead of restoring all defaults', () => {
    const page = makePage({ root: { moduleId: 'base.image', props: { src: '/authored.jpg', loading: 'unsupported' } } })
    const site = makeSite({ pages: [page] })
    expect(() => publishPage(page, site, registry)).toThrow(ModulePropsValidationError)
    try { publishPage(page, site, registry) } catch (error) {
      expect(error).toBeInstanceOf(ModulePropsValidationError)
      expect((error as ModulePropsValidationError).path).toContain('nodes.root/props/loading')
      expect((error as Error).cause).toBeInstanceOf(Error)
    }
  })

  it('parses real resolved values rather than editorial binding fallbacks', () => {
    const page = makePage({ root: {
      moduleId: 'base.image', props: { src: '/authored.jpg', loading: 'unsupported' },
      dynamicBindings: { loading: { source: 'currentEntry', field: 'loading', fallback: 'static' } },
    } })
    const config = { page, site: makeSite({ pages: [page] }), registry,
      templateContext: { entryStack: [{ id: 'row', fields: { loading: 'eager' } }] },
    }
    expect(renderNode('root', config, makeAccumulators())).toContain('loading="eager"')
    expect(() => renderNode('root', { ...config, templateContext: { entryStack: [{ id: 'row', fields: { loading: 'unsupported' } }] } }, makeAccumulators())).toThrow(ModulePropsValidationError)
  })

  it.each([
    { moduleId: 'base.loop', props: { pagination: 'unsupported' } },
    { moduleId: 'base.visual-component-ref', props: { componentId: { invalid: true } } },
  ])('applies the same hard boundary before the special renderer %j', root => {
    const page = makePage({ root })
    expect(() => publishPage(page, makeSite({ pages: [page] }), registry)).toThrow(ModulePropsValidationError)
  })

  it('defers visitor-dependent holes until their real request render', () => {
    const page = makePage({ root: { moduleId: 'base.image', props: { src: '/authored.jpg', loading: 'unsupported' } } })
    const config = { page, site: makeSite({ pages: [page] }), registry, dynamicNodeIds: new Set(['root']) }
    expect(renderNode('root', config, makeAccumulators())).toContain('<instatic-hole')
    expect(() => renderNode('root', { ...config, dynamicNodeIds: undefined }, makeAccumulators())).toThrow(ModulePropsValidationError)
  })
})
