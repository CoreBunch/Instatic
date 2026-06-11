import type { AnyModuleDefinition } from '@core/module-engine'
import {
  DEFAULT_MODULE_INSERTER_PREFERENCE,
  type ModuleInserterItemRef,
} from '@core/persistence/userPreferences'
import type { VisualComponent } from '@core/visualComponents'
import {
  countPresetNodes,
  type InsertionPreset,
} from './insertionPresets'
import {
  moduleWireForId,
  wireFromTree,
  type WireNode,
} from './moduleWireframes'

export type ModuleInserterAccent = 'mint' | 'lilac' | 'sky' | 'peach' | 'rose'
export type ModuleInserterSectionId =
  | 'modules'
  | 'layouts'
  | 'components'
  | 'recent'
export type ModuleInserterItemKind = 'module' | 'layout' | 'component'
export type ModuleInserterRecentRef = ModuleInserterItemRef

export interface RegistryModuleForInserter {
  id: string
  name: string
  category: string
  description?: string
}

interface BaseInserterItem {
  key: string
  id: string
  kind: ModuleInserterItemKind
  name: string
  description: string
  accent: ModuleInserterAccent
  wire: WireNode
  searchText: string
  /**
   * When set, the item renders greyed-out and cannot be inserted (click, Enter,
   * drag) — the string explains why, e.g. "Templates only". Disabled items stay
   * visible so authors learn the module exists and what unlocks it.
   */
  disabledReason?: string
}

export interface ModuleInserterModuleItem<
  TModule extends RegistryModuleForInserter = AnyModuleDefinition,
> extends BaseInserterItem {
  kind: 'module'
  module: TModule
  category: string
}

export interface ModuleInserterLayoutItem extends BaseInserterItem {
  kind: 'layout'
  preset: InsertionPreset
  blocks: number
}

export interface ModuleInserterComponentItem extends BaseInserterItem {
  kind: 'component'
  component: VisualComponent
  uses: number
}

export type ModuleInserterItem =
  | ModuleInserterModuleItem
  | ModuleInserterLayoutItem
  | ModuleInserterComponentItem

const HIDDEN_MODULE_IDS = new Set([
  'base.body',
  'base.visual-component-ref',
  'base.slot-instance',
])

export const DEFAULT_MODULE_INSERTER_FAVORITES =
  DEFAULT_MODULE_INSERTER_PREFERENCE.favorites

export function moduleAccentForCategory(category: string): ModuleInserterAccent {
  if (category === 'Forms') return 'mint'
  if (category === 'Media') return 'sky'
  if (category === 'Typography') return 'peach'
  if (category === 'Interactive' || category === 'CMS') return 'rose'
  return 'lilac'
}

/**
 * Where the picker is inserting into — drives per-module availability
 * (hidden / disabled-with-reason / insertable).
 */
export interface ModuleInsertionContext {
  /** The active document is a Visual Component definition tree. */
  isVCMode: boolean
  /** The active document is a template page (`template.enabled`). */
  isTemplate: boolean
  /** The active document tree already contains a `base.outlet`. */
  hasOutlet: boolean
}

export type ModuleAvailability =
  | { kind: 'insertable' }
  | { kind: 'hidden' }
  | { kind: 'disabled'; reason: string }

/**
 * Editor insertion rules for a registry module in the given context.
 *
 * - Auto-materialized internals (`base.body`, VC refs, slot instances) are
 *   never user-insertable → hidden.
 * - `base.slot-outlet` only means something inside a VC definition → hidden
 *   in page mode.
 * - `base.outlet` only means something on a template page (matched content
 *   flows into it), and a document holds at most one. Outside that context it
 *   stays VISIBLE but disabled with a reason, so authors discover the module
 *   and learn what unlocks it instead of hitting a blocked insert.
 */
export function moduleAvailability(
  mod: RegistryModuleForInserter,
  context: ModuleInsertionContext,
): ModuleAvailability {
  if (HIDDEN_MODULE_IDS.has(mod.id)) return { kind: 'hidden' }
  if (mod.id === 'base.slot-outlet' && !context.isVCMode) return { kind: 'hidden' }
  if (mod.id === 'base.outlet') {
    if (context.isVCMode) {
      return {
        kind: 'disabled',
        reason: 'Templates only — a component has no matched content to flow in.',
      }
    }
    if (!context.isTemplate) {
      return {
        kind: 'disabled',
        reason: 'Templates only — mark this page "Use as template" to place a content outlet.',
      }
    }
    if (context.hasOutlet) {
      return {
        kind: 'disabled',
        reason: 'This template already has a content outlet — matched content flows into just one.',
      }
    }
  }
  return { kind: 'insertable' }
}

export function getVisibleModuleItems<TModule extends RegistryModuleForInserter>(
  modules: readonly TModule[],
  context: ModuleInsertionContext,
): ModuleInserterModuleItem<TModule>[] {
  const items: ModuleInserterModuleItem<TModule>[] = []
  for (const mod of modules) {
    const availability = moduleAvailability(mod, context)
    if (availability.kind === 'hidden') continue
    const description = mod.description ?? `${mod.name} module`
    items.push({
      key: recentKey({ kind: 'module', id: mod.id }),
      id: mod.id,
      kind: 'module',
      name: mod.name,
      description,
      category: mod.category,
      accent: moduleAccentForCategory(mod.category),
      module: mod,
      wire: moduleWireForId(mod.id, mod.category),
      searchText: searchText([mod.name, mod.id, mod.category, description]),
      ...(availability.kind === 'disabled' ? { disabledReason: availability.reason } : {}),
    })
  }
  return items
}

export function getLayoutPresetItems(
  presets: readonly InsertionPreset[],
): ModuleInserterLayoutItem[] {
  return presets.map((preset) => ({
    key: recentKey({ kind: 'layout', id: preset.id }),
    id: preset.id,
    kind: 'layout',
    name: preset.name,
    description: preset.description,
    accent: preset.kind === 'form' ? 'mint' : 'sky',
    preset,
    blocks: countPresetNodes(preset.root),
    wire: preset.wire,
    searchText: searchText([preset.name, preset.id, preset.description, preset.kind]),
  }))
}

export function getComponentItems(
  components: readonly VisualComponent[],
): ModuleInserterComponentItem[] {
  return components.map((component) => ({
    key: recentKey({ kind: 'component', id: component.id }),
    id: component.id,
    kind: 'component',
    name: component.name,
    description: 'Saved Visual Component',
    accent: 'mint',
    component,
    uses: 0,
    wire: wireFromTree(component.tree),
    searchText: searchText([component.name, component.id, 'visual component']),
  }))
}

export interface BuiltModuleInserterItems {
  moduleItems: ModuleInserterModuleItem[]
  layoutItems: ModuleInserterLayoutItem[]
  componentItems: ModuleInserterComponentItem[]
  /** Every visible item — including disabled ones (carrying `disabledReason`). */
  allItems: ModuleInserterItem[]
}

export function buildModuleInserterItems({
  modules,
  context,
  layoutPresets,
  visualComponents,
}: {
  modules: readonly AnyModuleDefinition[]
  context: ModuleInsertionContext
  layoutPresets: readonly InsertionPreset[]
  visualComponents: readonly VisualComponent[]
}): BuiltModuleInserterItems {
  const moduleItems = getVisibleModuleItems(modules, context)
  const layoutItems = getLayoutPresetItems(layoutPresets)
  const componentItems = getComponentItems(visualComponents)
  return {
    moduleItems,
    layoutItems,
    componentItems,
    allItems: [
      ...moduleItems,
      ...layoutItems,
      ...componentItems,
    ],
  }
}

export function filterInserterItems<TItem extends ModuleInserterItem>(
  items: readonly TItem[],
  query: string,
): TItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((item) => item.searchText.includes(q))
}

export function recentRefForItem(item: ModuleInserterItem): ModuleInserterRecentRef {
  return { kind: item.kind, id: item.id }
}

export function resolveRecentItems(
  recent: readonly ModuleInserterRecentRef[],
  items: readonly ModuleInserterItem[],
): ModuleInserterItem[] {
  return resolveInserterRefs(recent, items)
}

export function resolveInserterRefs(
  refs: readonly ModuleInserterItemRef[],
  items: readonly ModuleInserterItem[],
): ModuleInserterItem[] {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const resolved: ModuleInserterItem[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const key = recentKey(ref)
    if (seen.has(key)) continue
    const item = byKey.get(key)
    if (!item) continue
    resolved.push(item)
    seen.add(key)
  }
  return resolved
}

export function dedupeModuleInserterRefs(
  refs: readonly ModuleInserterItemRef[],
): ModuleInserterItemRef[] {
  const deduped: ModuleInserterItemRef[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const key = recentKey(ref)
    if (seen.has(key)) continue
    deduped.push(ref)
    seen.add(key)
  }
  return deduped
}

export function itemDescription(item: ModuleInserterItem): string {
  // A disabled item's most useful description is WHY it can't be inserted here.
  if (item.disabledReason) return item.disabledReason
  if (item.kind === 'layout') return `${item.blocks} blocks · ${item.description}`
  if (item.kind === 'component') {
    const count = item.component.params.length
    return count === 1 ? '1 param · Saved component' : `${count} params · Saved component`
  }
  return item.description
}

export function recentKey(ref: ModuleInserterItemRef): string {
  return `${ref.kind}:${ref.id}`
}

function searchText(parts: readonly string[]): string {
  return parts.join(' ').toLowerCase()
}
