/**
 * Pack layouts — compile clean HTML (+ CSS) into the `SavedLayout` snapshot
 * the host stores and inserts.
 *
 * Plugin authors should not hand-write flat node maps and class registries;
 * they write the markup they already have:
 *
 *   layouts: [{
 *     id: 'hero-section',
 *     name: 'Hero section',
 *     html: '<section class="hero"><h1>Big claim</h1></section>',
 *     css: '.hero { padding: 96px 24px; text-align: center; }',
 *   }]
 *
 * Compilation runs at PLUGIN BUILD TIME (inside `instatic-plugin build`, which
 * installs a happy-dom polyfill) — the pack's `site.json` carries the
 * compiled `SavedLayout`, so the host install path stays on the one canonical
 * wire format and needs no DOM.
 *
 * Pipeline (same engines as the editor's "Paste HTML here…" / Site Import):
 *   1. `importHtml` parses the markup into a flat PageNode fragment —
 *      `<style>` blocks are harvested as CSS, scripts/handlers stripped.
 *   2. `cssToStyleRules` parses `entry.css` + harvested CSS into style rules.
 *   3. Class-kind rules get deterministic ids (`<layoutId>/<className>`), and
 *      node `classIds` (class NAMES at this point) are linked to those ids.
 *      Class names without a matching rule are dropped — they would be
 *      silently dropped at insertion time anyway.
 *   4. Multi-root markup is wrapped in a `base.container` so the snapshot is
 *      single-rooted like every saved layout.
 */

import { createNode, type PageNode, type StyleRule } from '@core/page-tree'
import { importHtml } from '@core/htmlImport'
import { cssToStyleRules } from '@core/siteImport'
import type { SavedLayout } from '@core/layouts'

export interface LayoutPackEntry {
  /** Stable layout id — auto-namespaced to `<pluginId>/<id>`. */
  id: string
  /** Display name shown in the module inserter's Layouts section. */
  name: string
  /** Clean HTML for the layout. `<style>` blocks contribute CSS. */
  html: string
  /** Additional CSS for the classes the HTML references. */
  css?: string
}

/** Auto-namespace a pack layout id unless the author already prefixed it. */
export function namespacedLayoutId(pluginId: string, id: string): string {
  return id.startsWith(`${pluginId}/`) ? id : `${pluginId}/${id}`
}

export function compilePackLayout(pluginId: string, entry: LayoutPackEntry): SavedLayout {
  if (typeof DOMParser === 'undefined') {
    throw new Error(
      `[plugin-sdk] Pack layout "${entry.id}" needs a DOM to compile its HTML. ` +
        `Build the plugin with \`instatic-plugin build\` (which provides one) ` +
        `instead of importing the pack config directly.`,
    )
  }

  const layoutId = namespacedLayoutId(pluginId, entry.id)
  const { nodes, rootIds, styleCss } = importHtml(entry.html)
  if (rootIds.length === 0) {
    throw new Error(`[plugin-sdk] Pack layout "${layoutId}" HTML produced no elements.`)
  }

  // Parse author CSS + harvested <style> CSS into style rules. No site
  // breakpoints exist at build time, so @media blocks become custom
  // conditions the snapshot cannot carry — keep pack layout CSS to plain
  // class/element rules.
  const css = [entry.css, styleCss].filter(Boolean).join('\n\n')
  const parsedRules = css ? cssToStyleRules(css).rules : []

  // Deterministic class ids: re-building the pack produces identical ids, so
  // re-inserting a layout after a pack update reuses the site's existing
  // class instead of importing a duplicate.
  const classes: Record<string, StyleRule> = {}
  const classIdByName = new Map<string, string>()
  let ambientIndex = 0
  for (const rule of parsedRules) {
    const id =
      rule.kind === 'class'
        ? `${layoutId}/${rule.name}`
        : `${layoutId}/ambient-${ambientIndex++}`
    if (rule.kind === 'class') classIdByName.set(rule.name, id)
    classes[id] = { ...rule, id, createdAt: 0, updatedAt: 0 }
  }

  // Link node classIds (class NAMES from the markup) to the rule ids.
  for (const node of Object.values(nodes)) {
    node.classIds = node.classIds.flatMap((name) => {
      const id = classIdByName.get(name)
      return id ? [id] : []
    })
  }

  // Single-root invariant: wrap multi-root markup in a container.
  let rootNodeId = rootIds[0]
  const snapshotNodes: Record<string, PageNode> = nodes
  if (rootIds.length > 1) {
    const wrapper = createNode('base.container')
    wrapper.children = [...rootIds]
    snapshotNodes[wrapper.id] = wrapper
    rootNodeId = wrapper.id
  }

  return {
    id: layoutId,
    name: entry.name,
    rootNodeId,
    nodes: snapshotNodes,
    classes,
    createdAt: 0,
  }
}
