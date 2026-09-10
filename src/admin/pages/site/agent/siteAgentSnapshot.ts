/**
 * The raw authoritative tree the site-editor agent posts each turn.
 *
 * Replaces the old flattened `SiteSnapshot`. The server renders this directly
 * (publishPage + buildSiteCssBundle) instead of consuming a bespoke flattened
 * shape — single source of truth, server owns all derivation.
 *
 * Only the ACTIVE page carries full `nodes`. Non-active pages keep metadata
 * (id/title/slug/template) with emptied `nodes`, because server-side catalog
 * tools only need document handles. Full document reads are browser-backed
 * against the live store so the snapshot does not ship every tree every turn.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { PageSchema, SiteShellSchema, type Page, type SiteDocument } from '@core/page-tree'
import { LocaleSchema } from '@core/localization-schema'
import { VisualComponentSchema } from '@core/visualComponents'
import { SavedLayoutSchema } from '@core/layouts'
import { AgentDocumentRefSchema, type AgentDocumentRef } from '@core/ai'

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
    localeId: Type.Optional(Type.String()),
    locales: Type.Optional(Type.Array(LocaleSchema)),
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
  /** Current editor document, which may be a page/template or a visual component. */
  currentDocument: AgentDocumentRefSchema,
  /** Site document: styleRules/settings/breakpoints intact; non-active pages emptied. */
  site: SiteDocumentSchema,
  selectedNodeId: Type.Union([Type.String(), Type.Null()]),
  activeBreakpointId: Type.String(),
})

export type SiteAgentSnapshot = Static<typeof SiteAgentSnapshotSchema>

interface SiteAgentSnapshotOptions {
  selectedNodeId: string | null
  activeBreakpointId: string
  currentDocument: AgentDocumentRef
}

export function buildSiteAgentSnapshot(
  page: Page,
  site: SiteDocument,
  options: SiteAgentSnapshotOptions,
): SiteAgentSnapshot {
  const { localization: _localization, ...projectedSite } = site
  const pages = site.pages.map((p) => (p.id === page.id ? p : { ...p, nodes: {} }))
  return {
    page,
    currentDocument: options.currentDocument,
    // Saved layouts are editor-only insertion templates — the agent never
    // reads them, so they ship emptied (same payload bounding as non-active
    // pages).
    site: { ...projectedSite, pages, layouts: [] },
    selectedNodeId: options.selectedNodeId,
    activeBreakpointId: options.activeBreakpointId,
  }
}
