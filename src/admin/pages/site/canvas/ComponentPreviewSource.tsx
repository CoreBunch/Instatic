import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { getCmsDataTableBySlug, listCmsDataTables, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { useEditorStore } from '@site/store/store'
import { Select } from '@ui/components/Select'
import styles from './VisualComponentModeControl.module.css'

/** Example data only: this selection never changes a component's runtime source. */
export function ComponentPreviewSource({ componentId }: { componentId: string }) {
  const selection = useEditorStore((s) => s.componentPreviewSelection[componentId])
  const setSelection = useEditorStore((s) => s.setComponentPreviewSelection)
  const tableSlug = selection?.tableSlug ?? ''
  const { data: tables } = useAsyncResource(() => listCmsDataTables(), [])
  const { data: rows, loading, error } = useAsyncResource(async () => {
    if (!tableSlug) return { tableSlug, items: [] }
    const table = await getCmsDataTableBySlug(tableSlug)
    if (!table) return { tableSlug, items: [] }
    const result = await previewCmsDataLoopItems(table.id, { orderBy: 'publishedAt', direction: 'desc', limit: 50 })
    return { tableSlug, items: result.items }
  }, [tableSlug])
  const items = rows?.tableSlug === tableSlug ? rows.items : []
  const value = items.some((item) => item.id === selection?.rowId) ? selection?.rowId : items[0]?.id

  return (
    <div className={styles.previewGroup} title="Example data for the editor only. The surrounding loop supplies data on the page.">
      <span className={styles.modeLabel}>Preview data</span>
      <Select
        fieldSize="sm"
        className={styles.previewSelect}
        aria-label="Component preview table"
        value={tableSlug}
        options={[
          { value: '', label: 'No example data' },
          ...(tables ?? []).filter((table) => table.kind === 'postType' || table.kind === 'data').map((table) => ({ value: table.slug, label: table.name })),
        ]}
        onChange={(event) => setSelection(componentId, event.target.value ? { tableSlug: event.target.value, rowId: null } : null)}
      />
      {tableSlug && <Select
        fieldSize="sm"
        className={styles.previewSelect}
        aria-label="Component preview entry"
        value={value ?? ''}
        disabled={loading || items.length === 0}
        options={items.length ? items.map((item) => ({ value: item.id, label: String(item.fields.title ?? item.fields.name ?? item.fields.slug ?? item.id) })) : [{ value: '', label: loading ? 'Loading…' : error ? 'Could not load entries' : 'Example content' }]}
        onChange={(event) => setSelection(componentId, { tableSlug, rowId: event.target.value })}
      />}
    </div>
  )
}
