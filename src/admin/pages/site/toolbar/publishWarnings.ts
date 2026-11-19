/**
 * What the editor does with the warnings of a publish that succeeded.
 *
 * Today there is one kind: a loop whose source nobody provides (its plugin
 * was disabled or removed, perhaps from another tab) published as an empty
 * list. The author is told, and the editor refetches the list of plugin
 * sources so the canvas shows that loop as unavailable too.
 *
 * Loaded on demand (`import()`), by a publish that came back with warnings.
 */
import type { CmsPublishResult } from '@core/persistence/responseSchemas'
import { pushToast } from '@ui/components/Toast'
import { requestLoopSourcesRefresh } from '@site/canvas/loopSourceEvents'

/** How many pages the toast names before it says "and N more". */
const NAMED = 2

export function showPublishWarnings(result: CmsPublishResult): void {
  const warnings = result.warnings ?? []
  if (warnings.length === 0) return
  const total = Math.max(result.warningsTotal ?? 0, warnings.length)
  const named = warnings
    .slice(0, NAMED)
    .map((warning) => `“${warning.sourceId}” on the page ${warning.page}`)
    .join(', ')
  const more = total > NAMED ? `, and ${total - NAMED} more` : ''
  pushToast({
    kind: 'warning',
    title: total === 1 ? 'Published, with an empty list' : `Published, with ${total} empty lists`,
    body:
      total === 1
        ? `A list uses a source that is not available: ${named}. Its plugin may be disabled or removed.`
        : `${total} lists use a source that is not available: ${named}${more}. A plugin may be disabled or removed.`,
    location: 'site-editor',
  })
  requestLoopSourcesRefresh()
}
