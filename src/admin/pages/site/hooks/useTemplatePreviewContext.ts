import { useEffect } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import type { Page } from '@core/page-tree'
import type { DataTable } from '@core/data/schemas'
import type { LoopItem } from '@core/loops'
import { getCmsDataTableBySlug, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { buildTemplateRenderContext, primaryTemplateTableSlug, type TemplateRenderDataContext } from '@core/templates'
import { useEditorStore } from '@site/store/store'
import { pushToast } from '@ui/components/Toast'

const EMPTY_FILE_REFERENCES = {}
const EMPTY_ROWS: LoopItem[] = []

export class TemplatePreviewDataError extends Error {
  readonly path: string
  constructor(path: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TemplatePreviewDataError'
    this.path = path
  }
}

interface TemplatePreviewContextState {
  context: TemplateRenderDataContext | undefined
  /** The same authorized, projected rows used by the source selector and live link. */
  rows: LoopItem[]
  table: DataTable | null
  loading: boolean
  error?: Error
  refresh: () => void
}

/** Real entry previews use the canonical page language; an empty table has no current entry. */
export function useTemplatePreviewContext(page: Page | null): TemplatePreviewContextState {
  const site = useEditorStore((s) => s.site)
  const tableSlug = page ? primaryTemplateTableSlug(page) : null
  const selectedRowId = useEditorStore((s) => (page ? s.templatePreviewSelection[page.id] ?? null : null))
  let baseContext: TemplateRenderDataContext | undefined
  let contextError: Error | undefined
  try {
    if (page && site) baseContext = buildTemplateRenderContext(page, site, { entryStack: [], files: EMPTY_FILE_REFERENCES })
  } catch (cause) {
    contextError = cause instanceof Error ? cause : new TemplatePreviewDataError('template.context', 'Invalid render context', cause)
  }
  const language = baseContext?.site?.language
  const requestKey = JSON.stringify([tableSlug, language])
  const { data, loading, error: loadError, refresh } = useAsyncResource(async () => {
    if (!tableSlug || !language) return null
    const table = await getCmsDataTableBySlug(tableSlug)
    if (!table) throw new TemplatePreviewDataError(`tables.${tableSlug}`, 'The template data table was not found')
    const result = await previewCmsDataLoopItems(table.id, { orderBy: 'publishedAt', direction: 'desc', limit: 50, language })
    return { key: requestKey, table, rows: result.items }
  }, [requestKey])
  useEffect(() => {
    if (loadError) pushToast({ kind: 'error', title: 'Could not preview template content', body: loadError,
      action: { label: 'Retry', onSelect: refresh } })
  }, [loadError, refresh])

  const current = data?.key === requestKey && !loadError ? data : null
  const rows = current?.rows ?? EMPTY_ROWS
  const state = { rows, table: current?.table ?? null, loading: Boolean(tableSlug && language) && loading, refresh }
  if (contextError) return { ...state, context: undefined, error: contextError }
  if (tableSlug && loadError) return { ...state, context: undefined,
    error: new TemplatePreviewDataError(`tables.${tableSlug}`, loadError) }
  if (!baseContext || (tableSlug && !current)) return { ...state, context: undefined }
  const chosen = selectedRowId ? rows.find(row => row.id === selectedRowId) : rows[0]
  if (tableSlug && selectedRowId && !chosen) return { ...state, context: undefined,
    error: new TemplatePreviewDataError('template.previewSelection', 'The selected entry is not available in this preview') }
  return { ...state, context: { ...baseContext, entryStack: chosen ? [chosen] : [] } }
}
