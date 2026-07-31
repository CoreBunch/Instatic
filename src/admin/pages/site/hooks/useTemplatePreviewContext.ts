import { useAsyncResource } from '@admin/lib/useAsyncResource'
import type { Page } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { dataTablePreviewToLoopItem } from '@core/templates/templatePreviewData'
import { getCmsDataTableBySlug, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { buildPageFrame, buildRouteFrame, buildSiteFrame } from '@core/templates/contextFrames'
import { primaryTemplateTableSlug } from '@core/templates'
import { useEditorStore } from '@site/store/store'

/**
 * Build the canvas-side render context used by `resolveDynamicProps`.
 *
 * Returns the context plus its post-type entry loading state so bindings
 * resolve live in the editor and Agent evidence can wait for real preview
 * data before capturing:
 *   - `page`, `site`, `route` — built from the in-memory site document
 *     and the currently active page. Match the values the publisher
 *     will compute at render time.
 *   - `entryStack` — populated only for template pages, with a single
 *     synthetic preview row from the table's schema. Loop iterations
 *     push/pop on top of this stack via `NodeRenderer`'s loop branch.
 */
interface TemplatePreviewContextState {
  context: TemplateRenderDataContext | undefined
  /** True while a post-type template's real preview row is still loading. */
  loading: boolean
}

export function useTemplatePreviewContext(page: Page | null): TemplatePreviewContextState {
  // Read site once; the page argument is already reactive via the caller.
  const site = useEditorStore((s) => s.site)

  // ── Template-page entry-stack seed ───────────────────────────────────
  // A `postTypes` template previews against the FIRST REAL published row of
  // its first targeted table — live data, consistent with how `everywhere`
  // templates preview the first real page. Only when the table has no
  // published rows yet do we fall back to a synthetic sample row so the layout
  // is still visible. An `everywhere` layout has no current entry (null
  // tableSlug → empty entry stack); its outlet previews a page instead.
  const tableSlug = page ? primaryTemplateTableSlug(page) : null
  // The post the author picked to preview (TemplateModeControl), or null → the
  // first published row. Session-only; keyed by the template page id.
  const selectedRowId = useEditorStore((s) => (page ? s.templatePreviewSelection[page.id] ?? null : null))
  // Fetch a window of published rows once per table; the chosen row is picked
  // from it below so changing the preview selection never refetches. A failed
  // load resolves to an empty window so bindings stay empty rather than throw.
  const { data: previewState, loading } = useAsyncResource<{
    tableSlug: string
    items: TemplateRenderDataContext['entryStack']
    synthetic: TemplateRenderDataContext['entryStack'][number] | null
  } | null>(
    () =>
      tableSlug
        ? getCmsDataTableBySlug(tableSlug)
            .then(async (table) => {
              if (!table) return { tableSlug, items: [], synthetic: null }
              const synthetic = dataTablePreviewToLoopItem(table)
              try {
                const { items } = await previewCmsDataLoopItems(table.id, {
                  orderBy: 'publishedAt',
                  direction: 'desc',
                  limit: 50,
                })
                return { tableSlug, items, synthetic }
              } catch {
                return { tableSlug, items: [], synthetic }
              }
            })
            .catch(() => ({ tableSlug, items: [], synthetic: null }))
        : Promise.resolve(null),
    [tableSlug],
  )

  // ── Compose the full context ─────────────────────────────────────────
  // The template entry stack is only valid for the currently-loaded
  // tableSlug; outside that, the stack stays empty so bindings against
  // currentEntry stay empty until the loop interceptor pushes a real
  // iteration on top.
  const previewEntryLoading = Boolean(tableSlug) && loading
  if (!page || !site) return { context: undefined, loading: previewEntryLoading }
  let entryStack: TemplateRenderDataContext['entryStack'] = []
  if (tableSlug && previewState?.tableSlug === tableSlug) {
    // Selected row → first published row → synthetic sample (empty table).
    const chosen =
      (selectedRowId ? previewState.items.find((item) => item.id === selectedRowId) : undefined)
      ?? previewState.items[0]
      ?? previewState.synthetic
    entryStack = chosen ? [chosen] : []
  }
  const pageFrame = buildPageFrame(page)
  return {
    loading: previewEntryLoading,
    context: {
      entryStack,
      page: pageFrame,
      site: buildSiteFrame(site),
      // Route frame mirrors what the published page will see. Editor
      // doesn't have the real request URL, so we derive from the page's
      // permalink — same shape, same fields.
      route: buildRouteFrame(pageFrame.permalink),
    },
  }
}
