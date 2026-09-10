import { Type } from '@core/utils/typeboxHelpers'
import { LocaleSchema, TableLocalizationSchema, type Locale, type LocaleInput, type LocaleUpdateInput } from '@core/localization-schema'
import { apiRequest } from '@core/http'
import { DataRowSchema, DataFieldSchema } from '@core/data/schemas'

const LocalesEnvelopeSchema = Type.Object({ locales: Type.Array(LocaleSchema) })
const LocaleEnvelopeSchema = Type.Object({ locale: LocaleSchema })
const RowLocalizationsSchema = Type.Object({
  locales: Type.Array(LocaleSchema),
  rows: Type.Array(DataRowSchema),
  fields: Type.Array(DataFieldSchema),
})

export async function getCmsTableLocalizations(tableId: string) {
  return apiRequest(`/admin/api/cms/data/tables/${encodeURIComponent(tableId)}/localizations`, {
    schema: Type.Object({ locales: Type.Array(LocaleSchema), localizations: Type.Array(TableLocalizationSchema) }),
    fallbackMessage: 'Unable to load collection languages',
  })
}

export async function updateCmsTableLocalization(tableId: string, localeId: string, routeBase: string) {
  return apiRequest(`/admin/api/cms/data/tables/${encodeURIComponent(tableId)}/localizations`, {
    method: 'PATCH', query: { localeId }, body: { routeBase },
    schema: Type.Object({ localization: TableLocalizationSchema }),
    fallbackMessage: 'Unable to update collection URL path',
  })
}

export async function getCmsRowLocalizations(rowId: string) {
  return apiRequest(`/admin/api/cms/data/rows/${encodeURIComponent(rowId)}/localizations`, {
    schema: RowLocalizationsSchema, fallbackMessage: 'Unable to load translations',
  })
}

export async function changeCmsTranslation(rowId: string, localeId: string, input: {
  action: 'reset' | 'review'; fieldId: string; nodeId?: string; property?: string
}) {
  const body = await apiRequest(`/admin/api/cms/data/rows/${encodeURIComponent(rowId)}/translation?localeId=${encodeURIComponent(localeId)}`, {
    method: 'POST', body: input, schema: Type.Object({ row: DataRowSchema }),
    fallbackMessage: 'Unable to update translation',
  })
  return body.row
}

export async function listCmsLocales(): Promise<Locale[]> {
  const body = await apiRequest('/admin/api/cms/locales', {
    schema: LocalesEnvelopeSchema,
    fallbackMessage: 'Unable to load languages',
  })
  return body.locales
}

export async function createCmsLocale(input: LocaleInput): Promise<Locale> {
  const body = await apiRequest('/admin/api/cms/locales', {
    method: 'POST', body: input, schema: LocaleEnvelopeSchema,
    fallbackMessage: 'Unable to add language',
  })
  return body.locale
}

export async function updateCmsLocale(id: string, input: LocaleUpdateInput): Promise<Locale> {
  const body = await apiRequest(`/admin/api/cms/locales/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input, schema: LocaleEnvelopeSchema,
    fallbackMessage: 'Unable to update language',
  })
  return body.locale
}
