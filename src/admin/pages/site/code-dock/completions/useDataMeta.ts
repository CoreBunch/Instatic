/**
 * The CMS data-table schemas for token completion (`{currentEntry.<field>}`
 * inside a table-bound loop). Reads the binding picker's module-level cache,
 * loading it once; while unavailable the completions simply lack table
 * fields — never an error surface.
 */
import { useEffect, useState } from 'react'
import type { DataMeta } from '@core/data/schemas'
import { _cachedMeta, loadDataMeta } from '@admin/shared/DataBindingPicker'

// Every panel mount retries a failed load (the cache clears on error); one
// warning per session is enough to explain the missing table fields.
let warnedUnavailable = false

export function useDataMeta(): DataMeta | null {
  const [meta, setMeta] = useState<DataMeta | null>(() => _cachedMeta)
  useEffect(() => {
    if (_cachedMeta) return
    let cancelled = false
    loadDataMeta()
      .then((loaded) => {
        if (!cancelled) setMeta(loaded)
      })
      .catch((err) => {
        if (warnedUnavailable) return
        warnedUnavailable = true
        console.warn('[useDataMeta] data meta unavailable, table fields will not complete:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return meta
}
