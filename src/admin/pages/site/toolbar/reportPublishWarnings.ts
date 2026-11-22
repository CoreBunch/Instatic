/**
 * Hand a publish result to the code that shows its warnings.
 *
 * Warnings are rare, so that code lives in its own chunk and is fetched only
 * by a publish that has some. If the chunk cannot be loaded (the tab is
 * offline, or a deploy replaced it), the author still learns that the publish
 * went through and that there was something to say.
 */
import type { CmsPublishResult } from '@core/persistence/responseSchemas'
import { pushToast } from '@ui/components/Toast'

type Loader = () => Promise<{ showPublishWarnings: (result: CmsPublishResult) => void }>

const loadShowPublishWarnings: Loader = () => import('./publishWarnings')

export async function reportPublishWarnings(
  result: CmsPublishResult,
  load: Loader = loadShowPublishWarnings,
): Promise<void> {
  if (!result.warnings?.length) return
  try {
    const { showPublishWarnings } = await load()
    showPublishWarnings(result)
  } catch (err) {
    console.error('[publish] Loading the publish warnings failed:', err)
    pushToast({
      kind: 'warning',
      title: 'Published, with warnings',
      body: 'The site was published, but its warnings could not be shown. Reload the editor and check the lists on your pages.',
      location: 'site-editor',
    })
  }
}
