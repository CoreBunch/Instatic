import { createContext, useContext, useEffect, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { readCmsDataLocalization } from '@core/persistence'
import { hasLocalizedDataFields, type DataLocalizationContext } from '@core/data/localizedCells'
import type { DataLocalization, DataTable } from '@core/data/schemas'
import { pushToast } from '@ui/components/Toast'

export interface LocalizedDataState {
  language: string
  setLanguage: (language: string) => void
  data: DataLocalization | null
  context: DataLocalizationContext | undefined
  loading: boolean
  error: string | null
  refresh: () => void
  required: boolean
}

export const LocalizedDataContext = createContext<LocalizedDataState | null>(null)
export function useLocalizedData(): LocalizedDataState | null { return useContext(LocalizedDataContext) }

/** No automatic language selection, and no copy of resolved text is written into row drafts. */
export function useLocalizedDataResource(tables: readonly DataTable[], revision: unknown): LocalizedDataState {
  const [language, setLanguage] = useState('')
  const localizedTables = tables.filter(table => hasLocalizedDataFields(table.fields)).sort((a, b) => a.id.localeCompare(b.id))
  const tableIds = localizedTables.map(table => table.id)
  const tableIdsKey = JSON.stringify(tableIds)
  const schemaKey = JSON.stringify(localizedTables.map(table => ({ id: table.id, fields: table.fields })))
  const required = tableIds.length > 0
  const scopeKey = `${schemaKey}\0${language}`
  const resource = useAsyncResource<{ tableIdsKey: string; scopeKey: string; data: DataLocalization | null }>(
    async () => ({ tableIdsKey, scopeKey, data: required ? await readCmsDataLocalization(tableIds, language || undefined) : null }),
    [schemaKey, language, revision],
  )
  useEffect(() => {
    if (resource.error) pushToast({ kind: 'error', title: 'Could not load localized data', body: resource.error,
      action: { label: 'Retry', onSelect: resource.refresh } })
  }, [resource.error, resource.refresh])
  // Keep the authorized language choices available while another language fails;
  // its text projection still requires an exact request identity and success.
  const previous = resource.data?.tableIdsKey === tableIdsKey ? resource.data.data : null
  const data: DataLocalization | null = resource.data?.scopeKey === scopeKey ? resource.data.data : previous && {
    languages: previous.languages, canBrowseCatalogue: previous.canBrowseCatalogue,
  }
  const context = language && typeof data?.language === 'string' && data.language === language && data.translations && !resource.error
    ? { language: data.language, translations: data.translations }
    : undefined
  return { language, setLanguage, data, context, required, loading: resource.loading, error: resource.error, refresh: resource.refresh }
}

/** Selected table plus relation targets, scoped by the same readable table metadata. */
export function localizedScopeTables(table: DataTable | null, tables: readonly DataTable[]): DataTable[] {
  if (!table) return []
  const targetIds = new Set(table.fields.flatMap(field => field.type === 'relation' ? [field.targetTableId] :
    field.type === 'repeater' ? field.fields.flatMap(item => item.type === 'relation' ? [item.targetTableId] : []) : []))
  targetIds.add(table.id)
  return tables.filter(candidate => targetIds.has(candidate.id))
}
