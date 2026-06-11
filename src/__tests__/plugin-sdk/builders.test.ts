/**
 * Tests for the @instatic/plugin-sdk builders. Each builder is
 * exercised end-to-end: input → output → host runtime shape.
 */
import { describe, expect, it } from 'bun:test'
import {
  control,
  createNamespace,
  defineComponent,
  defineModule,
  definePack,
  definePlugin,
  escapeHtml,
  h,
  html,
  permissions,
  raw,
  safeUrl,
  vc,
} from '@core/plugin-sdk'
// Layout compilation maps HTML elements to base.* modules via the registry.
import '@modules/base'

describe('html tag', () => {
  it('escapes interpolated values', () => {
    const value = '<script>alert("x")</script>'
    expect(html`<p>${value}</p>`).toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>')
  })

  it('passes through raw markup', () => {
    expect(html`<div>${raw('<b>safe</b>')}</div>`).toBe('<div><b>safe</b></div>')
  })

  it('joins arrays of values', () => {
    const items = ['a', 'b', 'c']
    expect(html`<ul>${items.map((i) => raw(`<li>${escapeHtml(i)}</li>`))}</ul>`)
      .toBe('<ul><li>a</li><li>b</li><li>c</li></ul>')
  })

  it('renders null and undefined as empty string', () => {
    expect(html`<p>${null}-${undefined}-${''}</p>`).toBe('<p>--</p>')
  })
})

describe('safeUrl', () => {
  it('blocks javascript: and vbscript: schemes', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#')
    expect(safeUrl('vbscript:foo')).toBe('#')
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBe('#')
  })

  it('passes through normal URLs', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com')
    expect(safeUrl('/path')).toBe('/path')
    expect(safeUrl(undefined)).toBe('')
  })
})

describe('control factories', () => {
  it('produces typed PluginPropertyControl entries', () => {
    expect(control.text('Title')).toEqual({ type: 'text', label: 'Title' })
    expect(control.textarea('Body', { rows: 4 }))
      .toEqual({ type: 'textarea', label: 'Body', rows: 4 })
    expect(control.select('Tone', [{ label: 'Info', value: 'info' }]))
      .toEqual({ type: 'select', label: 'Tone', options: [{ label: 'Info', value: 'info' }] })
    expect(control.toggle('Featured')).toEqual({ type: 'toggle', label: 'Featured' })
  })
})

describe('permissions', () => {
  it('exposes typed canonical permission strings', () => {
    expect(permissions.modulesRegister).toBe('modules.register')
    expect(permissions.cmsHooks).toBe('cms.hooks')
  })
})

describe('createNamespace', () => {
  it('produces module / vc / classRef ids under the plugin id', () => {
    const ns = createNamespace('acme.ui-kit')
    expect(ns.module('callout')).toBe('acme.ui-kit.callout')
    expect(ns.vc('hero')).toBe('acme.ui-kit/hero')
    expect(ns.classRef('section')).toBe('acme.ui-kit/section')
  })

  it('rejects invalid plugin ids', () => {
    expect(() => createNamespace('no-dot')).toThrow(/must be namespaced/)
  })

  it('rejects invalid name segments', () => {
    const ns = createNamespace('acme.ui-kit')
    expect(() => ns.module('Has Spaces')).toThrow(/invalid/)
    expect(() => ns.vc('UPPER')).toThrow(/invalid/)
  })
})

describe('defineModule', () => {
  it('infers props type from defaults inside render', () => {
    const mod = defineModule({
      id: 'acme.ui-kit.callout',
      name: 'Callout',
      category: 'UI Kit',
      defaults: { title: 'Heads up', tone: 'info' as const },
      schema: {
        title: control.text('Title'),
        tone: control.select('Tone', [
          { label: 'Info', value: 'info' },
          { label: 'Warning', value: 'warning' },
        ]),
      },
      render: ({ props }) => ({
        html: `<aside class="t-${props.tone}">${escapeHtml(props.title)}</aside>`,
      }),
    })

    const out = mod.render({ title: 'Hi', tone: 'info' }, [])
    expect(out.html).toBe('<aside class="t-info">Hi</aside>')
    expect(mod.id).toBe('acme.ui-kit.callout')
    expect(mod.version).toBe('1.0.0')
  })

  it('rejects non-namespaced module ids at definition time', () => {
    expect(() => defineModule({
      id: 'no-dot',
      name: 'Bad',
      category: 'X',
      defaults: {},
      schema: {},
      render: () => ({ html: '' }),
    })).toThrow(/namespaced/)
  })
})

describe('h.* tree builder + defineComponent', () => {
  it('flattens nested h calls into a NodeTree<VCNode>', () => {
    const component = vc('acme.ui-kit/hero', 'Hero', () =>
      h.container({ tag: 'section' }, [
        h.text({ tag: 'h1', text: 'Hello world' }),
        h.button({ label: 'Go', href: '#go' }),
      ]),
    )

    expect(component.id).toBe('acme.ui-kit/hero')
    expect(component.name).toBe('Hero')
    const root = component.tree.nodes[component.tree.rootNodeId]
    expect(root.moduleId).toBe('base.container')
    expect(root.children).toHaveLength(2)
    expect(component.tree.nodes[root.children[0]].moduleId).toBe('base.text')
    expect(component.tree.nodes[root.children[1]].moduleId).toBe('base.button')
  })

  it('produces stable ids across rebuilds (idempotent install)', () => {
    const a = defineComponent('a/x', 'Same', () =>
      h.container({}, [h.text({ text: 'Hi' })]),
    )
    const b = defineComponent('a/x', 'Same', () =>
      h.container({}, [h.text({ text: 'Hi' })]),
    )
    expect(a.tree.rootNodeId).toBe(b.tree.rootNodeId)
    expect(Object.keys(a.tree.nodes)).toEqual(Object.keys(b.tree.nodes))
  })

  it('collects classIds referenced anywhere in the tree on the VC.classIds', () => {
    const component = vc('acme.ui-kit/hero', 'Hero', () =>
      h.container({ classIds: ['acme.ui-kit/section'] }, [
        h.text({ text: 'X', classIds: ['acme.ui-kit/heading-xl'] }),
      ]),
    )
    expect(component.classIds.sort()).toEqual([
      'acme.ui-kit/heading-xl',
      'acme.ui-kit/section',
    ])
  })

  it('h.custom passes through arbitrary plugin-module ids', () => {
    const component = vc('acme.x/y', 'Y', () =>
      h.custom('acme.x.callout', { title: 'Hi', tone: 'info' }),
    )
    const root = component.tree.nodes[component.tree.rootNodeId]
    expect(root.moduleId).toBe('acme.x.callout')
    expect(root.props).toEqual({ title: 'Hi', tone: 'info' })
  })
})

describe('definePack', () => {
  it('expands the classes shorthand into namespaced StyleRule entries with safe names', () => {
    const pack = definePack({
      pluginId: 'acme.ui-kit',
      classes: {
        section: { paddingTop: '72px', maxWidth: '1120px' },
        'heading-xl': {
          name: 'uikit-heading-xl',
          styles: { fontSize: '3rem' },
        },
      },
    })

    expect(pack.classes).toHaveLength(2)
    const section = pack.classes.find((c) => c.id === 'acme.ui-kit/section')!
    expect(section.name).toBe('acme-ui-kit-section')
    expect(section.styles.paddingTop).toBe('72px')

    const headingXl = pack.classes.find((c) => c.id === 'acme.ui-kit/heading-xl')!
    expect(headingXl.name).toBe('uikit-heading-xl')
  })

  it('rejects explicit names that contain whitespace', () => {
    expect(() => definePack({
      pluginId: 'acme.ui-kit',
      classes: {
        x: { name: 'my class', styles: {} },
      },
    })).toThrow(/CSS name/)
  })

  it('compiles HTML layout entries into namespaced SavedLayout snapshots', () => {
    const pack = definePack({
      pluginId: 'acme.ui-kit',
      layouts: [{
        id: 'hero-section',
        name: 'Hero section',
        html: '<section class="hero missing-rule"><h2>Big claim</h2></section>',
        css: '.hero { padding: 96px; text-align: center; }',
      }],
    })

    expect(pack.layouts).toHaveLength(1)
    const layout = pack.layouts[0]
    expect(layout.id).toBe('acme.ui-kit/hero-section')
    expect(layout.name).toBe('Hero section')

    const root = layout.nodes[layout.rootNodeId]
    expect(root).toBeDefined()
    // The class with a CSS rule links to a deterministic namespaced id; the
    // class name without one is dropped (it would be dropped at insert time).
    expect(root.classIds).toEqual(['acme.ui-kit/hero-section/hero'])
    const heroClass = layout.classes['acme.ui-kit/hero-section/hero']
    expect(heroClass?.name).toBe('hero')
    // The CSS engine expands shorthands to longhands.
    expect(heroClass?.styles.paddingTop).toBe('96px')
    expect(heroClass?.styles.textAlign).toBe('center')

    // The heading made it into the subtree.
    const allNodes = Object.values(layout.nodes)
    expect(allNodes.length).toBeGreaterThanOrEqual(2)
  })

  it('harvests <style> blocks from the layout HTML as CSS', () => {
    const pack = definePack({
      pluginId: 'acme.ui-kit',
      layouts: [{
        id: 'styled',
        name: 'Styled',
        html: '<style>.card { border-radius: 16px; }</style><div class="card">Hi</div>',
      }],
    })
    const layout = pack.layouts[0]
    expect(layout.classes['acme.ui-kit/styled/card']?.styles.borderTopLeftRadius).toBe('16px')
    expect(layout.nodes[layout.rootNodeId].classIds).toEqual(['acme.ui-kit/styled/card'])
  })

  it('wraps multi-root layout HTML in a single container root', () => {
    const pack = definePack({
      pluginId: 'acme.ui-kit',
      layouts: [{
        id: 'two-parts',
        name: 'Two parts',
        html: '<header>Top</header><footer>Bottom</footer>',
      }],
    })
    const layout = pack.layouts[0]
    const root = layout.nodes[layout.rootNodeId]
    expect(root.moduleId).toBe('base.container')
    expect(root.children).toHaveLength(2)
  })

  it('compiles deterministic class ids across rebuilds', () => {
    const entry = {
      id: 'hero-section',
      name: 'Hero section',
      html: '<section class="hero">Hi</section>',
      css: '.hero { color: red; }',
    }
    const a = definePack({ pluginId: 'acme.ui-kit', layouts: [entry] })
    const b = definePack({ pluginId: 'acme.ui-kit', layouts: [entry] })
    expect(Object.keys(a.layouts[0].classes)).toEqual(Object.keys(b.layouts[0].classes))
  })

  it('rejects layout HTML that produces no elements', () => {
    expect(() => definePack({
      pluginId: 'acme.ui-kit',
      layouts: [{ id: 'empty', name: 'Empty', html: '   ' }],
    })).toThrow(/no elements/)
  })
})

describe('definePlugin', () => {
  it('produces a runtime PluginManifest plus bundled builder outputs', () => {
    const definition = definePlugin({
      id: 'acme.ui-kit',
      name: 'UI Kit',
      version: '1.0.0',
      permissions: [permissions.modulesRegister, permissions.visualComponentsRegister],
      modules: [
        defineModule({
          id: 'acme.ui-kit.callout',
          name: 'Callout',
          category: 'UI Kit',
          defaults: { title: 'X' },
          schema: { title: control.text('Title') },
          render: ({ props }) => ({ html: `<p>${escapeHtml(props.title)}</p>` }),
        }),
      ],
      pack: definePack({
        pluginId: 'acme.ui-kit',
        classes: { section: { paddingTop: '24px' } },
      }),
    })

    expect(definition.manifest.id).toBe('acme.ui-kit')
    expect(definition.manifest.permissions.sort()).toEqual([
      'modules.register',
      'visualComponents.register',
    ].sort())
    expect(definition.modules).toHaveLength(1)
    expect(definition.pack?.classes[0].id).toBe('acme.ui-kit/section')
  })

  it('rejects plugin ids without a vendor namespace', () => {
    expect(() => definePlugin({
      id: 'just-name',
      name: 'X',
      version: '1.0.0',
      permissions: [],
    })).toThrow(/namespaced/)
  })

  it('rejects modules whose id does not start with the plugin id', () => {
    expect(() => definePlugin({
      id: 'acme.ui-kit',
      name: 'UI Kit',
      version: '1.0.0',
      permissions: [],
      modules: [
        defineModule({
          id: 'other.ns.callout',
          name: 'Wrong',
          category: 'X',
          defaults: {},
          schema: {},
          render: () => ({ html: '' }),
        }),
      ],
    })).toThrow(/must start with the plugin id/)
  })
})
