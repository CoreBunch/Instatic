import { describe, expect, it } from 'bun:test'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { mediaCanvasInsertionForAsset } from '@site/panels/MediaExplorerPanel/mediaCanvasInsertion'

function asset(overrides: Partial<CmsMediaAsset>): CmsMediaAsset {
  return {
    id: 'asset-1',
    filename: 'file.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: 1024,
    publicPath: '/uploads/file.bin',
    uploadedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    altText: '',
    caption: '',
    title: '',
    tags: [],
    width: null,
    height: null,
    durationMs: null,
    dominantColor: null,
    deletedAt: null,
    replacedAt: null,
    folderIds: [],
    blurHash: null,
    variants: [],
    posterPath: null,
    ...overrides,
  }
}

describe('mediaCanvasInsertionForAsset', () => {
  it('turns image assets into base.image defaults', () => {
    expect(mediaCanvasInsertionForAsset(asset({
      filename: 'hero.png',
      mimeType: 'image/png',
      publicPath: '/uploads/hero.png',
    }))).toEqual({
      moduleId: 'base.image',
      defaults: { src: '/uploads/hero.png' },
      name: 'Image',
    })
  })

  it('turns video assets into base.video defaults', () => {
    expect(mediaCanvasInsertionForAsset(asset({
      filename: 'intro.mp4',
      mimeType: 'video/mp4',
      publicPath: '/uploads/intro.mp4',
    }))).toEqual({
      moduleId: 'base.video',
      defaults: { videoUrl: '/uploads/intro.mp4' },
      name: 'Video',
    })
  })

  it('uses filename fallback buckets when MIME type is generic', () => {
    expect(mediaCanvasInsertionForAsset(asset({
      filename: 'clip.webm',
      mimeType: 'application/octet-stream',
      publicPath: '/uploads/clip.webm',
    }))?.moduleId).toBe('base.video')
  })

  it('does not create canvas modules for other asset types', () => {
    expect(mediaCanvasInsertionForAsset(asset({
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      publicPath: '/uploads/document.pdf',
    }))).toBeNull()
  })
})
