/**
 * Tier-2 module-engine + first-party module consolidation (findings F2–F11).
 *
 * Each block proves a previously-duplicated piece of logic now lives in exactly
 * one shared place and behaves identically, plus the explicit publish-dispatch
 * contract (F2) and schema-derived defaults (F7).
 */
import { describe, it, expect } from 'bun:test'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'

import type { AnyModuleDefinition, ModuleDefinition } from '@core/module-engine'
import { registry, resolveHtmlTagBadge } from '@core/module-engine'
import {
  resolveSpecialRenderer,
  getSpecialRendererModuleIds,
  type RenderResolvedMedia,
} from '@core/publisher'
import { resolveSlotName, safePropOverrides } from '@core/visualComponents'
import { VOID_HTML_ELEMENTS } from '@modules/base/utils/htmlTag'
import { buildMediaSrcset, pickMediaVariantUrl } from '@modules/base/utils/mediaAttrs'
import { Value } from '@core/utils/typeboxHelpers'

// Importing the base pack self-registers every first-party module on the
// global registry singleton.
import '@modules/base'

function makeModule(id: string, overrides: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return {
    id,
    name: 'Test Module',
    category: 'Test',
    version: '1.0.0',
    icon: SquareSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: {},
    defaults: {},
    component: () => null as never,
    render: () => ({ html: '<div></div>' }),
    ...overrides,
  }
}

function makeMedia(overrides: Partial<RenderResolvedMedia> = {}): RenderResolvedMedia {
  return {
    publicPath: '/uploads/hero.webp',
    mimeType: 'image/webp',
    width: 1200,
    height: 800,
    altText: '',
    blurHash: null,
    posterPath: null,
    variants: [
      { width: 320, height: 213, format: 'webp', path: '/uploads/hero-w320.webp', sizeBytes: 100 },
      { width: 640, height: 427, format: 'webp', path: '/uploads/hero-w640.webp', sizeBytes: 200 },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// F3 — shared media srcset / variant pick
// ---------------------------------------------------------------------------

describe('F3 buildMediaSrcset / pickMediaVariantUrl', () => {
  it('builds an ascending srcset from the variants ONLY — never the original', () => {
    // The original is excluded deliberately: it may be a multi-MB PNG, and
    // any srcset candidate is selectable (a 1280px slot on a 2x display asks
    // for 2560px — if the original tops the ladder, every retina visitor
    // downloads it). The ladder's top rung is the intrinsic-width WebP.
    expect(buildMediaSrcset(makeMedia())).toBe(
      '/uploads/hero-w320.webp 320w, /uploads/hero-w640.webp 640w',
    )
  })

  it('never includes the original even when it is the only large candidate', () => {
    const srcset = buildMediaSrcset(makeMedia({ publicPath: '/uploads/hero.png', width: 2688 }))
    expect(srcset).not.toContain('.png')
  })

  it('returns null when there are no variants', () => {
    expect(buildMediaSrcset(makeMedia({ variants: [] }))).toBeNull()
  })

  it('picks the smallest variant at or above the target width', () => {
    expect(pickMediaVariantUrl(makeMedia(), 400)).toBe('/uploads/hero-w640.webp')
    expect(pickMediaVariantUrl(makeMedia(), 100)).toBe('/uploads/hero-w320.webp')
    expect(pickMediaVariantUrl(null, 400)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// F4 — image alt is HTML-escaped via the canonical escapeHtml
// ---------------------------------------------------------------------------

describe('F4 image alt escaping', () => {
  it('escapes special chars in alt text through the canonical escaper', () => {
    const img = registry.getOrThrow('base.image')
    const out = img.render(
      {
        src: '/uploads/hero.webp',
        loading: 'lazy',
        fetchPriority: 'auto',
        decoding: 'async',
        _resolvedMediaByKey: { src: makeMedia({ altText: 'a & b <c> "d"' }) },
      },
      [],
    )
    expect(out.html).toContain('alt="a &amp; b &lt;c&gt; &quot;d&quot;"')
  })
})

// ---------------------------------------------------------------------------
// F8 — single void-element set
// ---------------------------------------------------------------------------

describe('F8 VOID_HTML_ELEMENTS', () => {
  it('contains the standard void tags', () => {
    for (const t of ['br', 'hr', 'img', 'input', 'wbr', 'source']) {
      expect(VOID_HTML_ELEMENTS.has(t)).toBe(true)
    }
    expect(VOID_HTML_ELEMENTS.has('div')).toBe(false)
  })

  it('container render self-closes a void tag (via custom) and wraps a normal tag', () => {
    const container = registry.getOrThrow('base.container')
    // Void tags reach the container through the custom-tag escape hatch.
    expect(container.render({ tag: 'custom', customTag: 'br' }, ['x']).html).toBe('<br>')
    expect(container.render({ tag: 'section', customTag: '' }, ['x']).html).toBe('<section>x</section>')
  })
})

// ---------------------------------------------------------------------------
// F9 / F10 — slotName + propOverrides guards
// ---------------------------------------------------------------------------

describe('F9 resolveSlotName', () => {
  it('returns the slot name when a non-empty string, else "children"', () => {
    expect(resolveSlotName({ slotName: 'header' })).toBe('header')
    expect(resolveSlotName({ slotName: '' })).toBe('children')
    expect(resolveSlotName({ slotName: 42 })).toBe('children')
    expect(resolveSlotName(undefined)).toBe('children')
  })
})

describe('F10 safePropOverrides', () => {
  it('returns the object only when it is a plain object', () => {
    const obj = { a: 1 }
    expect(safePropOverrides({ propOverrides: obj })).toBe(obj)
    expect(safePropOverrides({ propOverrides: null })).toEqual({})
    expect(safePropOverrides({ propOverrides: [1, 2] })).toEqual({})
    expect(safePropOverrides({ propOverrides: 'x' })).toEqual({})
    expect(safePropOverrides(undefined)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// F11 — htmlTag badge dispatch
// ---------------------------------------------------------------------------

describe('F11 resolveHtmlTagBadge', () => {
  it('dispatches the three htmlTag shapes', () => {
    expect(resolveHtmlTagBadge({ htmlTag: 'IMG' }, {})).toBe('img')
    expect(resolveHtmlTagBadge({ htmlTag: (p) => (p.x ? 'a' : null) }, { x: 1 })).toBe('a')
    expect(resolveHtmlTagBadge({ htmlTag: () => null }, {})).toBeNull()
    expect(resolveHtmlTagBadge({ htmlTag: undefined }, {})).toBeNull()
    expect(resolveHtmlTagBadge(undefined, {})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// F2 — publishBehavior contract
// ---------------------------------------------------------------------------

describe('F2 publishBehavior dispatch', () => {
  it('first-party special modules declare publishBehavior:"special"', () => {
    expect(registry.getOrThrow('base.loop').publishBehavior).toBe('special')
    expect(registry.getOrThrow('base.visual-component-ref').publishBehavior).toBe('special')
  })

  it('first-party transparent modules declare publishBehavior:"transparent"', () => {
    expect(registry.getOrThrow('base.slot-instance').publishBehavior).toBe('transparent')
    expect(registry.getOrThrow('base.slot-outlet').publishBehavior).toBe('transparent')
  })

  it('every publisher special-renderer id is a module declaring publishBehavior:"special"', () => {
    // The contract is two-way and stays in sync: the publisher provides a
    // specialised renderer for exactly the modules that declare 'special'.
    const declaredSpecial = registry
      .list()
      .filter((m) => m.publishBehavior === 'special')
      .map((m) => m.id)
      .sort()
    expect(getSpecialRendererModuleIds().sort()).toEqual(declaredSpecial)
  })

  it('resolveSpecialRenderer returns the impl for special modules, undefined for standard', () => {
    expect(typeof resolveSpecialRenderer(registry.getOrThrow('base.loop'))).toBe('function')
    expect(resolveSpecialRenderer(makeModule('test.standard') as AnyModuleDefinition)).toBeUndefined()
  })

  it('declaring special without a registered impl throws (forgotten renderer fails loudly)', () => {
    const orphan = makeModule('test.special-orphan', { publishBehavior: 'special' }) as AnyModuleDefinition
    expect(() => resolveSpecialRenderer(orphan)).toThrow(/no specialised renderer/)
  })

  it('registering a transparent module whose render is non-empty throws', () => {
    const bad = makeModule('test.transparent-bad', {
      publishBehavior: 'transparent',
      render: () => ({ html: '<div></div>' }),
    })
    expect(() => registry.registerOrReplace(bad)).toThrow(/transparent/)

    const good = makeModule('test.transparent-good', {
      publishBehavior: 'transparent',
      render: () => ({ html: '' }),
    })
    expect(() => registry.registerOrReplace(good)).not.toThrow()
    registry.unregister('test.transparent-good')
    registry.unregister('test.transparent-bad')
  })
})

// ---------------------------------------------------------------------------
// F7 — defaults derive from the schema (Value.Create), not hand-maintained
// ---------------------------------------------------------------------------

describe('F7 schema-derived defaults', () => {
  for (const id of ['base.slot-instance', 'base.slot-outlet', 'base.visual-component-ref']) {
    it(`${id} defaults equal Value.Create(propsSchema)`, () => {
      const def = registry.getOrThrow(id)
      expect(def.propsSchema).toBeDefined()
      expect(def.defaults).toEqual(Value.Create(def.propsSchema!))
    })
  }

  it('a field added to the schema flows into Value.Create defaults', () => {
    const def = registry.getOrThrow('base.visual-component-ref')
    const created = Value.Create(def.propsSchema!) as Record<string, unknown>
    // The schema declares componentId + propOverrides; both must appear in the
    // derived defaults — proving defaults track the schema rather than a stale
    // hand-written literal.
    expect(created).toHaveProperty('componentId')
    expect(created).toHaveProperty('propOverrides')
  })
})
