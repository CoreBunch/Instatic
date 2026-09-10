import type { ContentLocalization, Locale } from '@core/localization-schema'

export const SOURCE_LOCALE: Locale = {
  id: 'default', code: 'en', name: 'English', pathPrefix: '', isDefault: true, enabled: true, direction: 'ltr',
}

export function makeContentLocalization(rowId: string, overrides: Partial<ContentLocalization> = {}): ContentLocalization {
  return {
    rowId, localeId: SOURCE_LOCALE.id, cells: {}, slug: '', availability: 'offline', activeVersionId: null,
    scheduledPublishAt: null, scheduledRevision: null, translationMeta: {}, seq: 0,
    createdByUserId: null, updatedByUserId: null, publishedByUserId: null,
    createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', publishedAt: null,
    ...overrides,
  }
}
