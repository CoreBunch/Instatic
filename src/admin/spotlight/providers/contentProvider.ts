import { getActiveAdminLocale } from "@admin/i18n"
/**
 * Content provider — live data row search via /admin/api/cms/data/search.
 *
 * SERVER provider, 150 ms debounce.
 *
 * "Content documents" in this CMS are data rows stored in data_tables.
 * The search endpoint filters by row slug (a URL-safe lowercase derivative
 * of the content title) and returns lightweight row summaries.
 *
 * Navigation: /admin/content?table=<tableSlug>&row=<rowId> — the content
 * workspace deep-links via these query params (see useContentWorkspace.ts).
 */

import type { Command } from '../types'
import { DataSearchResponseSchema } from './schemas'
import { makeServerProvider } from './serverProvider'

export const contentProvider = makeServerProvider({
  id: 'content',
  label: 'Content',
  debounceMs: 150,
  endpoint: '/admin/api/cms/data/search',
  schema: DataSearchResponseSchema,
  select: (body) => body.entries,
  toCommand: (entry): Command => {
    // Humanise the slug for display: replace hyphens with spaces and capitalise.
    const displayTitle = entry.slug
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')

    return {
      id: `content:${entry.id}`,
      title: displayTitle,
      subtitle: `${entry.tableName} · ${formatDate(entry.updatedAt)}`,
      group: 'content',
      iconName: 'file-text-solid',
      keywords: ['content', 'document', entry.tableSlug, entry.slug],
      run: (ctx) => {
        ctx.closeSpotlight()
        ctx.navigate(`/admin/content?table=${encodeURIComponent(entry.tableSlug)}&row=${encodeURIComponent(entry.id)}`)
      },
    }
  },
})

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(getActiveAdminLocale(), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}
