/**
 * The raw authoritative tree the site-editor agent posts each turn.
 *
 * Replaces the old flattened `SiteSnapshot`. The server renders this directly
 * (publishPage + buildSiteCssBundle) instead of consuming a bespoke flattened
 * shape — single source of truth, server owns all derivation.
 *
 * Only the ACTIVE page carries full `nodes`. Non-active pages keep metadata
 * (id/title/slug) with emptied `nodes`, because server-side rendering and CSS
 * collection only ever touch the active page + site-level styleRules. This
 * bounds the per-turn payload on multi-page sites.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { PageSchema, SiteShellSchema, type Page, type SiteDocument } from '@core/page-tree'
import { VisualComponentSchema } from '@core/visualComponents'
import { SavedLayoutSchema } from '@core/layouts'

/**
 * In-memory site document validated as a single value: the persisted shell
 * (`SiteShellSchema`) plus the pages, visual components, and saved layouts the
 * adapter assembles onto it. Mirrors the `SiteDocument` type from
 * `@core/page-tree`, but as a runtime-checkable schema so the snapshot
 * boundary can validate it.
 */
const SiteDocumentSchema = Type.Composite([
  SiteShellSchema,
  Type.Object({
    pages: Type.Array(PageSchema),
    visualComponents: Type.Array(VisualComponentSchema),
    layouts: Type.Array(SavedLayoutSchema),
  }),
])

/**
 * The raw authoritative snapshot the browser posts each turn. This schema is
 * the source of truth — `SiteAgentSnapshot` is its `Static` type, and the chat
 * handler validates the untyped HTTP body against it before building a prompt.
 */
export const SiteAgentSnapshotSchema = Type.Object({
  /** Active page, full node map — the tree the agent reads and mutates. */
  page: PageSchema,
  /** Site document: styleRules/settings/breakpoints intact; non-active pages emptied. */
  site: SiteDocumentSchema,
  selectedNodeId: Type.Union([Type.String(), Type.Null()]),
  activeBreakpointId: Type.String(),
})

export type SiteAgentSnapshot = Static<typeof SiteAgentSnapshotSchema>

interface SiteAgentSnapshotOptions {
  selectedNodeId: string | null
  activeBreakpointId: string
}

export function buildSiteAgentSnapshot(
  page: Page,
  site: SiteDocument,
  options: SiteAgentSnapshotOptions,
): SiteAgentSnapshot {
  const pages = site.pages.map((p) => (p.id === page.id ? p : { ...p, nodes: {} }))
  return {
    page,
    // Saved layouts are editor-only insertion templates — the agent never
    // reads them, so they ship emptied (same payload bounding as non-active
    // pages).
    site: { ...site, pages, layouts: [] },
    selectedNodeId: options.selectedNodeId,
    activeBreakpointId: options.activeBreakpointId,
  }
}
