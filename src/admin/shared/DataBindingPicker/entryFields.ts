/**
 * Which fields a `currentEntry` exposes when a loop is bound to a specific
 * data table: the table's own fields plus the loop source's synthetic
 * metadata (permalink, author, …) that the table doesn't already declare.
 * Shared by the binding picker's field list and the God Mode token
 * completions so the two can never disagree.
 */
import type { DataMetaTable } from '@core/data/schemas'

/**
 * Loop synthetic fields that only make sense on `postType` tables. Hidden
 * when the entry comes from a `kind: 'data'` table (no body, featured media,
 * SEO, etc.).
 */
const POST_TYPE_ONLY_LOOP_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'body',
  'featuredMedia',
  'firstImage',
  'seoTitle',
  'seoDescription',
])

/** The loop source's synthetic fields that add to `table`'s own fields. */
export function loopMetadataFields<F extends { id: string }>(
  table: { kind: DataMetaTable['kind']; fields: readonly { id: string }[] },
  sourceFields: readonly F[],
): F[] {
  const tableFieldIds = new Set(table.fields.map((field) => field.id))
  return sourceFields.filter(
    (field) =>
      !tableFieldIds.has(field.id)
      && (table.kind === 'postType' || !POST_TYPE_ONLY_LOOP_FIELDS.has(field.id)),
  )
}
