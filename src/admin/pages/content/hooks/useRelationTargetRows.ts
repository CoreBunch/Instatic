import { useEffect, useState } from 'react'
import { listCmsDataRows } from '@core/persistence'
import type { DataField, DataRow } from '@core/data/schemas'

/**
 * Resolves relation-field target rows for display in the Content settings
 * panel. Fetches the rows of every DISTINCT table targeted by a relation
 * field once, then answers `resolveRow(rowId)` lookups synchronously — the
 * same contract `RelationCell` consumes via `resolveRelationTarget`.
 *
 * Fetch failures are non-fatal: an unresolved id falls back to raw-id
 * display in the cell.
 */
export function useRelationTargetRows(fields: DataField[]): (rowId: string) => DataRow | null {
  const [rowsByTable, setRowsByTable] = useState<ReadonlyMap<string, DataRow[]>>(new Map())

  // Stable key over the SET of target tables — sorted so field order and
  // identity churn don't retrigger the fetch effect.
  const targetKey = [...new Set(
    fields.flatMap((field) => (field.type === 'relation' ? [field.targetTableId] : [])),
  )].sort().join('\0')

  // Render-time reset when the target-table set changes (the React-recommended
  // adjust-state-during-render pattern) — the effect below only fetches.
  const [prevTargetKey, setPrevTargetKey] = useState(targetKey)
  if (prevTargetKey !== targetKey) {
    setPrevTargetKey(targetKey)
    setRowsByTable(new Map())
  }

  useEffect(() => {
    if (targetKey === '') return
    let cancelled = false
    const tableIds = targetKey.split('\0')
    void Promise.all(
      tableIds.map(async (tableId) => {
        // Non-fatal: a missing / forbidden target table resolves to no rows.
        const rows = await listCmsDataRows(tableId).catch(() => [] as DataRow[])
        return [tableId, rows] as const
      }),
    ).then((pairs) => {
      if (!cancelled) setRowsByTable(new Map(pairs))
    })
    return () => { cancelled = true }
  }, [targetKey])

  return (rowId: string) => {
    for (const rows of rowsByTable.values()) {
      const match = rows.find((row) => row.id === rowId)
      if (match) return match
    }
    return null
  }
}
