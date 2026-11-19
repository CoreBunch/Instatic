/**
 * What the editor does with the warnings of a publish that succeeded.
 *
 * Today there is one kind: a loop whose source nobody provides (its plugin
 * was disabled or removed, perhaps from another tab) published as an empty
 * list. The author is told, and the editor refetches the list of plugin
 * sources so the canvas shows that loop as unavailable too.
 */
import type { CmsPublishWarning } from '@core/persistence/responseSchemas'
import { pushToast } from '@ui/components/Toast'
import { requestLoopSourcesRefresh } from '@site/canvas/loopSourceEvents'

export function showPublishWarnings(warnings: readonly CmsPublishWarning[]): void {
  if (warnings.length === 0) return
  const lines = warnings.map((warning) => `${warning.where}: “${warning.sourceId}”`)
  pushToast({
    kind: 'warning',
    title: warnings.length === 1 ? 'Published, with an empty list' : 'Published, with empty lists',
    body:
      `A list has no source and was published empty. Its plugin may be disabled or removed. ${lines.join('; ')}.`,
    location: 'site-editor',
  })
  requestLoopSourcesRefresh()
}
