import { useState } from 'react'
import { parsePageSeo, SeoStructuredDataSchema, type PageSeo } from '@core/page-tree'
import { safeParseJson } from '@core/utils/jsonValidate'
import { getErrorMessage } from '@core/utils/errorMessage'

export function usePageSeoEditor(initial: PageSeo | undefined) {
  const [seo, setSeo] = useState<PageSeo>(structuredClone(initial ?? {}))
  const [structuredText, setStructuredText] = useState(initial?.structuredData?.length
    ? JSON.stringify(initial.structuredData, null, 2) : '')
  let value: PageSeo | undefined
  let error: string | null = null
  try {
    const candidate = { ...seo }
    if (structuredText.trim()) {
      const parsed = safeParseJson(structuredText, SeoStructuredDataSchema)
      if (!parsed.ok) throw parsed.error
      candidate.structuredData = parsed.value
    } else delete candidate.structuredData
    for (const key of ['title', 'description', 'canonical'] as const) {
      if (!candidate[key]?.trim()) delete candidate[key]
    }
    for (const key of ['alternates', 'meta', 'links'] as const) {
      if (!candidate[key]?.length) delete candidate[key]
    }
    value = Object.keys(candidate).length ? parsePageSeo(candidate) : undefined
  } catch (cause) {
    error = getErrorMessage(cause, 'Invalid document metadata')
  }
  return { seo, setSeo, structuredText, setStructuredText, value, error }
}

