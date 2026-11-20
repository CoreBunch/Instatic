/**
 * What the editor does with the warnings of a publish that succeeded.
 *
 * Today there is one kind: loops whose source nobody provides (its plugin
 * was disabled or removed, perhaps from another tab) published as empty
 * lists. The author is told, and the editor refetches the list of plugin
 * sources so the canvas shows those loops as unavailable too.
 *
 * Loaded on demand by `reportPublishWarnings`, for a publish that came back
 * with warnings.
 */
import type { CmsPublishResult, CmsPublishWarning } from '@core/persistence/responseSchemas'
import { pushToast } from '@ui/components/Toast'
import { requestLoopSourcesRefresh } from '@site/canvas/loopSourceEvents'

/** How many sources the toast names before it says "and N more". */
const NAMED = 2

function where(warning: CmsPublishWarning): string {
  const first = warning.pages[0]
  if (!first) return `“${warning.sourceId}”`
  if (warning.pageCount <= 1) return `“${warning.sourceId}” (on ${first})`
  const others = warning.pageCount - 1
  return `“${warning.sourceId}” (on ${first} and ${others} other ${others === 1 ? 'page' : 'pages'})`
}

export function showPublishWarnings(result: CmsPublishResult): void {
  const warnings = result.warnings ?? []
  if (warnings.length === 0) return
  const total = Math.max(result.warningsTotal ?? 0, warnings.length)
  const named = warnings.slice(0, NAMED).map(where).join(', ')
  const more = total > NAMED ? `, and ${total - NAMED} more` : ''
  pushToast({
    kind: 'warning',
    title:
      total === 1 ? 'Published, but a loop source is not available' : `Published, but ${total} loop sources are not available`,
    body: `${named}${more}. Loops that use ${total === 1 ? 'it' : 'them'} were published empty. A plugin may be disabled or removed.`,
    location: 'site-editor',
  })
  requestLoopSourcesRefresh()
}
