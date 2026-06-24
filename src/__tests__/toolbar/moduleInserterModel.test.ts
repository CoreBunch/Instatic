import { beforeEach, describe, expect, it } from 'bun:test'
import {
  DEFAULT_MODULE_INSERTER_FAVORITES,
  composeLayoutsSection,
  dedupeModuleInserterRefs,
  getSavedLayoutItems,
  getVisibleModuleItems,
  layoutPluginId,
  moduleAccentForCategory,
  moduleAvailability,
  resolveInserterRefs,
  type ModuleInsertionContext,
  type RegistryModuleForInserter,
} from '@site/module-picker/moduleInserterModel'
import type { SavedLayout } from '@core/layouts'
import { findCanvasViewportAtPoint } from '@site/module-picker/moduleInserterDropTarget'
import { scrollSelectedItemIntoView } from '@site/module-picker/moduleInserterSelectionScroll'
import {
  MODULE_INSERTER_STORAGE_KEY,
  readModuleInserterPrefs,
  trackModuleInserterRecent,
  writeModuleInserterView,
} from '@site/module-picker/moduleInserterPrefs'

function mod(id: string, category: string, name = id): RegistryModuleForInserter {
  return { id, category, name, description: `${name} description` }
}

const PAGE_CTX: ModuleInsertionContext = { isVCMode: false, activeVcId: null, isTemplate: false, hasOutlet: false }
const TEMPLATE_CTX: ModuleInsertionContext = { isVCMode: false, activeVcId: null, isTemplate: true, hasOutlet: false }
const VC_CTX: ModuleInsertionContext = { isVCMode: true, activeVcId: 'vc-1', isTemplate: false, hasOutlet: false }

beforeEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})

describe('module inserter model', () => {
  it('filters registry modules using the editor insertion rules', () => {
    const modules = [
      mod('base.body', 'Layout'),
      mod('base.container', 'Layout', 'Container'),
      mod('base.visual-component-ref', 'Components'),
      mod('base.slot-instance', 'Components'),
      mod('base.slot-outlet', 'Components', 'Slot'),
      mod('base.text', 'Typography', 'Text'),
    ]

    const pageModeIds = getVisibleModuleItems(modules, PAGE_CTX).map((item) => item.id)
    expect(pageModeIds).toEqual(['base.container', 'base.text'])

    const vcModeIds = getVisibleModuleItems(modules, VC_CTX).map((item) => item.id)
    expect(vcModeIds).toEqual(['base.container', 'base.slot-outlet', 'base.text'])
  })

  it('keeps the content outlet visible but disabled outside an insertable template context', () => {
    const outlet = mod('base.outlet', 'CMS', 'Content Outlet')

    // Regular page: visible, disabled, reason explains the template requirement.
    const onPage = moduleAvailability(outlet, PAGE_CTX)
    expect(onPage.kind).toBe('disabled')

    // VC definition tree: disabled too — no matched content inside a component.
    const inVC = moduleAvailability(outlet, VC_CTX)
    expect(inVC.kind).toBe('disabled')

    // Template without an outlet: insertable.
    expect(moduleAvailability(outlet, TEMPLATE_CTX)).toEqual({ kind: 'insertable' })

    // Template that already has its outlet: disabled (one per document).
    const alreadyPlaced = moduleAvailability(outlet, { ...TEMPLATE_CTX, hasOutlet: true })
    expect(alreadyPlaced.kind).toBe('disabled')

    // Disabled items still appear in the item list, carrying the reason.
    const items = getVisibleModuleItems([outlet], PAGE_CTX)
    expect(items).toHaveLength(1)
    expect(items[0].disabledReason).toBeTruthy()

    // …and insertable contexts produce no disabledReason at all.
    expect(getVisibleModuleItems([outlet], TEMPLATE_CTX)[0].disabledReason).toBeUndefined()
  })

  it('maps module categories to the categorical accent set', () => {
    expect(moduleAccentForCategory('Layout')).toBe('lilac')
    expect(moduleAccentForCategory('Forms')).toBe('mint')
    expect(moduleAccentForCategory('Media')).toBe('sky')
    expect(moduleAccentForCategory('Typography')).toBe('peach')
    expect(moduleAccentForCategory('Interactive')).toBe('rose')
    expect(moduleAccentForCategory('Custom')).toBe('lilac')
  })

  it('deduplicates inserter refs by kind and id while preserving first order', () => {
    expect(dedupeModuleInserterRefs([
      { kind: 'module', id: 'base.text' },
      { kind: 'module', id: 'base.text' },
      { kind: 'savedLayout', id: 'user-layout-1' },
      { kind: 'module', id: 'base.image' },
      { kind: 'savedLayout', id: 'user-layout-1' },
    ])).toEqual([
      { kind: 'module', id: 'base.text' },
      { kind: 'savedLayout', id: 'user-layout-1' },
      { kind: 'module', id: 'base.image' },
    ])
  })

  it('resolves favorite refs against insertable items and skips missing refs', () => {
    const items = getVisibleModuleItems([
      mod('base.container', 'Layout', 'Container'),
      mod('base.text', 'Typography', 'Text'),
      mod('base.image', 'Media', 'Image'),
    ], PAGE_CTX)

    const resolved = resolveInserterRefs([
      ...DEFAULT_MODULE_INSERTER_FAVORITES,
      { kind: 'module', id: 'base.missing' },
    ], items)

    expect(resolved.map((item) => item.id)).toEqual([
      'base.container',
      'base.text',
      'base.image',
    ])
  })
})

describe('module inserter preferences', () => {
  it('falls back to grid view and empty recents for corrupted localStorage', () => {
    localStorage.setItem(MODULE_INSERTER_STORAGE_KEY, '{not valid json')

    expect(readModuleInserterPrefs()).toEqual({
      view: 'grid',
      recent: [],
    })
  })

  it('persists view mode and de-duplicates recent insertion refs', () => {
    writeModuleInserterView('list')

    trackModuleInserterRecent({ kind: 'module', id: 'base.text' })
    trackModuleInserterRecent({ kind: 'savedLayout', id: 'user-layout-1' })
    trackModuleInserterRecent({ kind: 'module', id: 'base.text' })

    expect(readModuleInserterPrefs()).toEqual({
      view: 'list',
      recent: [
        { kind: 'module', id: 'base.text' },
        { kind: 'savedLayout', id: 'user-layout-1' },
      ],
    })
  })
})

describe('module inserter canvas drop targeting', () => {
  it('finds the breakpoint viewport under the pointer instead of assuming the active frame', () => {
    const desktop = document.createElement('div')
    desktop.dataset.breakpointId = 'desktop'
    const mobile = document.createElement('div')
    mobile.dataset.breakpointId = 'mobile'

    desktop.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 300,
      width: 200,
      height: 300,
      toJSON: () => ({}),
    })
    mobile.getBoundingClientRect = () => ({
      x: 240,
      y: 0,
      left: 240,
      top: 0,
      right: 360,
      bottom: 300,
      width: 120,
      height: 300,
      toJSON: () => ({}),
    })

    document.body.append(desktop, mobile)

    expect(findCanvasViewportAtPoint(260, 100)).toBe(mobile)
    expect(findCanvasViewportAtPoint(120, 100)).toBe(desktop)
    expect(findCanvasViewportAtPoint(220, 100)).toBeNull()
  })
})

describe('module inserter selection scrolling', () => {
  it('only scrolls offscreen selection for keyboard navigation, not pointer hover', () => {
    const container = document.createElement('div')
    const selected = document.createElement('button')
    let scrollOptions: ScrollToOptions | null = null
    container.append(selected)
    container.scrollTop = 20
    container.scrollBy = ((options?: ScrollToOptions | number, y?: number) => {
      if (typeof options === 'number') {
        container.scrollTop += y ?? 0
        return
      }
      scrollOptions = options ?? {}
      container.scrollTop += options?.top ?? 0
    }) as typeof container.scrollBy

    container.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 100,
      width: 300,
      height: 100,
      toJSON: () => ({}),
    })
    selected.getBoundingClientRect = () => ({
      x: 0,
      y: 120,
      left: 0,
      top: 120,
      right: 300,
      bottom: 170,
      width: 300,
      height: 50,
      toJSON: () => ({}),
    })

    expect(scrollSelectedItemIntoView(container, selected, 'pointer')).toBe(false)
    expect(container.scrollTop).toBe(20)

    expect(scrollSelectedItemIntoView(container, selected, 'keyboard')).toBe(true)
    expect(scrollOptions?.behavior).toBe('smooth')
    expect(scrollOptions?.top).toBe(84)
    expect(container.scrollTop).toBe(104)
  })
})

// ---------------------------------------------------------------------------
// Layouts section composition (Saved · per-plugin) — every layout is a
// SavedLayout row; there are no code-defined presets.
// ---------------------------------------------------------------------------

function savedLayout(id: string, name: string): SavedLayout {
  return {
    id,
    name,
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.container',
        props: {},
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
    classes: {},
    createdAt: 0,
  }
}

describe('layouts section composition', () => {
  it('detects the owning plugin from the namespaced id', () => {
    expect(layoutPluginId(savedLayout('V1StGXR8_Z5jdHi6B-myT', 'Mine'))).toBeNull()
    expect(layoutPluginId(savedLayout('acme.kit/hero', 'Hero'))).toBe('acme.kit')
  })

  it('orders user layouts, then per-plugin groups (by display name) — with labels', () => {
    const saved = getSavedLayoutItems(
      [
        savedLayout('zzz.kit/footer', 'Footer'),
        savedLayout('user-layout-id1', 'My hero'),
        savedLayout('acme.kit/hero', 'Hero'),
      ],
      PAGE_CTX,
      [],
    )

    const { items, labelByKey } = composeLayoutsSection(saved, (pluginId) =>
      pluginId === 'acme.kit' ? 'Acme UI Kit' : null,
    )

    expect(items.map((i) => i.name)).toEqual(['My hero', 'Hero', 'Footer'])
    expect(labelByKey.get(items[0].key)).toBe('Saved')
    expect(labelByKey.get(items[1].key)).toBe('Acme UI Kit')
    // No display name registered → falls back to the plugin id.
    expect(labelByKey.get(items[2].key)).toBe('zzz.kit')
  })

  it('renders no labels when only the user group is present', () => {
    const saved = getSavedLayoutItems([savedLayout('user-layout-id1', 'My hero')], PAGE_CTX, [])
    const { items, labelByKey } = composeLayoutsSection(saved, () => null)
    expect(items).toHaveLength(1)
    expect(labelByKey.size).toBe(0)
  })

  it('yields an empty Layouts section on a fresh site (no presets leak in)', () => {
    const { items, labelByKey } = composeLayoutsSection([], () => null)
    expect(items).toHaveLength(0)
    expect(labelByKey.size).toBe(0)
  })
})
