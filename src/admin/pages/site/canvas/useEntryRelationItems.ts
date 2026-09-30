import { useEffect, useState } from 'react'
import { useActiveBranchId } from '@admin/state/branchStore'
import { logicalIdOf } from '@core/branches'
import { getCmsDataTable, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { safeParseJson } from '@core/utils/jsonValidate'
import { Type } from '@core/utils/typeboxHelpers'
import type { LoopItem } from '@core/loops'
import type { CanvasPreviewReadiness } from './CanvasPreviewReadiness'

const ReferenceIdsSchema = Type.Array(Type.String())

/** Relation lookup for the active outer entry; no synthetic unrelated target rows. */
export function useEntryRelationItems(
  entry: LoopItem | undefined,
  fieldId: string,
  enabled: boolean,
  readiness: CanvasPreviewReadiness | null,
): ReadonlyMap<string, LoopItem> | undefined {
  const branchId = useActiveBranchId()
  const rawTableId = entry?.fields.tableId
  const tableId = enabled && typeof rawTableId === 'string' ? logicalIdOf(branchId, rawTableId) : ''
  const value = entry?.fields[fieldId]
  const references = JSON.stringify(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [])
  const key = JSON.stringify([branchId, tableId, fieldId, references])
  const [resolved, setResolved] = useState<{ key: string; items?: Map<string, LoopItem> } | null>(null)
  useEffect(() => {
    if (!tableId || !fieldId) return
    let cancelled = false
    async function load() {
      const table = await getCmsDataTable(tableId)
      const field = table?.fields.find((candidate) => candidate.id === fieldId)
      if (field?.type !== 'relation' || !field.allowMultiple) {
        if (!cancelled) setResolved({ key })
        return
      }
      const parsed = safeParseJson(references, ReferenceIdsSchema)
      if (!parsed.ok) throw parsed.error
      const ids = [...new Set(parsed.value)]
      const items = new Map<string, LoopItem>()
      for (let start = 0; start < ids.length; start += 200) {
        const result = await previewCmsDataLoopItems(field.targetTableId, { rowIds: ids.slice(start, start + 200) })
        for (const item of result.items) items.set(item.id, item)
      }
      if (!cancelled) setResolved({ key, items })
    }
    const request = load().catch((error: unknown) => {
      console.error('[useEntryRelationItems] Relation preview failed:', error)
      if (!cancelled) setResolved({ key, items: new Map() })
    })
    readiness?.track(request)
    return () => { cancelled = true }
  }, [tableId, fieldId, references, key, readiness])
  return resolved?.key === key ? resolved.items : undefined
}
