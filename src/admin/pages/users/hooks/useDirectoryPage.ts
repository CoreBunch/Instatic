import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'

export function useDirectoryPage<T extends { offset: number; matching: number }>(
  filterKey: string,
  load: (offset: number, signal: AbortSignal) => Promise<T>,
  fallbackError: string,
) {
  const [request, setRequest] = useState({ filterKey, offset: 0 })
  if (request.filterKey !== filterKey) setRequest({ filterKey, offset: 0 })
  const offset = request.filterKey === filterKey ? request.offset : 0
  const resource = useAsyncResource((signal) => load(offset, signal), [filterKey, offset], { fallbackError })

  function goTo(nextOffset: number) {
    if (nextOffset === offset) resource.refresh()
    else setRequest({ filterKey, offset: nextOffset })
  }

  const pagination = resource.data && {
    offset: resource.data.offset,
    matching: resource.data.matching,
    busy: resource.loading,
    goTo,
  }
  return { ...resource, goTo, pagination }
}
