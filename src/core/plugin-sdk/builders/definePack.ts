/**
 * `definePack` — type-checked Visual Component / template / class pack.
 *
 *   import { definePack } from '@instatic/plugin-sdk'
 *   import hero from './pack/hero'
 *   import featureRow from './pack/featureRow'
 *
 *   export default definePack({
 *     pluginId: 'acme.ui-kit',
 *     visualComponents: [hero, featureRow],
 *     pages: [],
 *     classes: {
 *       section: { paddingTop: '72px', maxWidth: '1120px' },
 *       'heading-xl': { fontSize: 'clamp(2.4rem, 4vw, 3.4rem)', fontWeight: '700' },
 *     },
 *     layouts: [{
 *       id: 'hero-section',
 *       name: 'Hero section',
 *       html: '<section class="hero"><h1>Big claim</h1></section>',
 *       css: '.hero { padding: 96px 24px; text-align: center; }',
 *     }],
 *   })
 *
 * Wins over hand-rolled JSON:
 *   • `classes` is a `Record<className, styles>` map. Each entry compiles to
 *     `{ id: <pluginId>/<className>, name: <pluginId>-<className>, styles, ... }`
 *     — `name` is auto-derived to be a valid CSS identifier (no whitespace).
 *   • Visual Components arrive as already-built objects from `vc()` /
 *     `defineComponent()` — IDs and children are valid by construction.
 *   • Pages are validated only loosely here (full schema is the host's job),
 *     but the builder provides a typed entry point.
 *   • `pluginId` is required and used to namespace class IDs — no `$/` magic
 *     and no runtime drift.
 */

import type { StyleRule, Page } from '@core/page-tree'
import { classKindSelector } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { compilePackLayout, type LayoutPackEntry } from './packLayouts'

export interface PluginPackContents {
  visualComponents: VisualComponent[]
  pages: Page[]
  classes: StyleRule[]
  layouts: SavedLayout[]
}

interface DefinePackConfig {
  pluginId: string
  visualComponents?: VisualComponent[]
  pages?: Page[]
  /**
   * Map of `className -> styles`. The class id is auto-namespaced to
   * `<pluginId>/<className>`, the CSS classname is `<pluginId-snake>-<className>`
   * (snake-cased plugin id so vendor.product → vendor-product-class). Use
   * the longer object form `{ name?, styles, contextStyles? }` to
   * override the derived classname.
   */
  classes?: Record<string, ClassPackEntry>
  /**
   * Saved layouts — offered in the module inserter's Layouts section under
   * the plugin's name. Authored as clean HTML (+ optional CSS); compiled to
   * the host's snapshot format at build time by `compilePackLayout`. Ids are
   * auto-namespaced to `<pluginId>/<id>`; re-installs replace by id.
   */
  layouts?: LayoutPackEntry[]
}

type ClassPackEntry =
  | Record<string, unknown>
  | {
      name?: string
      styles: Record<string, unknown>
      contextStyles?: Record<string, Record<string, unknown>>
      description?: string
      tags?: string[]
    }

const NAME_TOKEN = /^[A-Za-z_][A-Za-z0-9_-]*$/

function snakeCasePluginId(pluginId: string): string {
  return pluginId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function defaultCssName(pluginId: string, className: string): string {
  return `${snakeCasePluginId(pluginId)}-${className}`
}

function isExpandedEntry(value: ClassPackEntry): value is {
  name?: string
  styles: Record<string, unknown>
  contextStyles?: Record<string, Record<string, unknown>>
  description?: string
  tags?: string[]
} {
  return Boolean(value) && typeof value === 'object' && 'styles' in (value as Record<string, unknown>)
}

export function definePack(config: DefinePackConfig): PluginPackContents {
  const classes: StyleRule[] = []
  for (const [className, entry] of Object.entries(config.classes ?? {})) {
    const expanded = isExpandedEntry(entry) ? entry : { styles: entry }
    const id = `${config.pluginId}/${className}`
    const name = expanded.name ?? defaultCssName(config.pluginId, className)
    if (!NAME_TOKEN.test(name)) {
      throw new Error(
        `[plugin-sdk] Class "${id}" CSS name "${name}" is invalid. Pass an explicit { name } to override the auto-derived value.`,
      )
    }
    classes.push({
      id,
      name,
      kind: 'class',
      selector: classKindSelector(name),
      order: 0,
      ...(expanded.description ? { description: expanded.description } : {}),
      styles: expanded.styles ?? {},
      contextStyles: expanded.contextStyles ?? {},
      ...(expanded.tags ? { tags: expanded.tags } : {}),
      createdAt: 0,
      updatedAt: 0,
    })
  }

  const layouts: SavedLayout[] = (config.layouts ?? []).map((entry) =>
    compilePackLayout(config.pluginId, entry),
  )

  return {
    visualComponents: config.visualComponents ?? [],
    pages: config.pages ?? [],
    classes,
    layouts,
  }
}
