import { useEffect, useState } from 'react'
import type { DataMeta, DataRow } from '@core/data/schemas'
import { listCmsDataRows } from '@core/persistence/cmsData'

export function useGlobalDataRows(
  meta: DataMeta | null,
): Readonly<Record<string, readonly DataRow[]>> {
  const [rowsByTable, setRowsByTable] = useState<
    Readonly<Record<string, readonly DataRow[]>>
  >({})

  useEffect(() => {
    if (!meta) return
    const tables = meta.tables.filter((table) => table.kind === 'data' && !table.system)
    let cancelled = false
    Promise.all(
      tables.map(async (table) => [table.id, await listCmsDataRows(table.id)] as const),
    )
      .then((entries) => {
        if (!cancelled) setRowsByTable(Object.fromEntries(entries))
      })
      .catch((err) => {
        console.error('[DataBindingPicker] failed to load custom data rows:', err)
        if (!cancelled) setRowsByTable({})
      })
    return () => {
      cancelled = true
    }
  }, [meta])

  return rowsByTable
}
