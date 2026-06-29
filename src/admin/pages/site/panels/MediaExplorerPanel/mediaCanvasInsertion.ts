import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { targetBucket } from './mediaExplorerUtils'

export type MediaCanvasModuleId = 'base.image' | 'base.video'

export interface MediaCanvasInsertion {
  moduleId: MediaCanvasModuleId
  defaults: Record<string, string>
  name: 'Image' | 'Video'
}

export function mediaCanvasInsertionForAsset(asset: CmsMediaAsset): MediaCanvasInsertion | null {
  const bucket = targetBucket(asset)
  if (bucket === 'images') {
    return {
      moduleId: 'base.image',
      defaults: { src: asset.publicPath },
      name: 'Image',
    }
  }

  if (bucket === 'videos') {
    return {
      moduleId: 'base.video',
      defaults: { videoUrl: asset.publicPath },
      name: 'Video',
    }
  }

  return null
}
