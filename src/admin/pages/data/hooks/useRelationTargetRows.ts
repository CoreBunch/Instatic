import { useEffect } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { listCmsDataRows } from '@core/persistence'
import type { DataField, DataRow } from '@core/data/schemas'
import { pushToast } from '@ui/components/Toast'

/** Relation labels use authorized target rows; failures remain visible and retryable. */
export function useRelationTargetRows(fields: readonly DataField[]) {
  const tableIds = [...new Set(fields.flatMap(field => field.type === 'relation' ? [field.targetTableId] :
    field.type === 'repeater' ? field.fields.flatMap(item => item.type === 'relation' ? [item.targetTableId] : []) : []))].sort()
  const key = JSON.stringify(tableIds)
  const resource = useAsyncResource(async () => ({ key, rows: (await Promise.all(tableIds.map(id => listCmsDataRows(id)))).flat() }), [key])
  useEffect(() => {
    if (resource.error) pushToast({ kind: 'error', title: 'Could not load related rows', body: resource.error,
      action: { label: 'Retry', onSelect: resource.refresh } })
  }, [resource.error, resource.refresh])
  const rows = resource.data?.key === key && !resource.error ? resource.data.rows : []
  return { ...resource, resolveRow: (rowId: string): DataRow | null => rows.find(row => row.id === rowId) ?? null }
}
