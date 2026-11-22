import { lazy, Suspense, useState } from 'react'
import { primeCmsMediaAssetCache } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import type { PageNode } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { revealSelectedCanvasNode } from './revealSelectedCanvasNode'

const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(({ MediaPickerModal }) => ({ default: MediaPickerModal })),
)

export function PhoneImageAction({ node }: { node: PageNode }) {
  const [open, setOpen] = useState(false)
  const src = typeof node.props.src === 'string' ? node.props.src : ''
  return (
    <>
      <Button variant="primary" size="md" onClick={() => setOpen(true)}>
        {src ? 'Replace image' : 'Choose image'}
      </Button>
      {open && (
        <Suspense fallback={null}>
          <MediaPickerModal open mediaKind="image" currentValue={src}
            onClose={() => {
              setOpen(false)
              requestAnimationFrame(() => revealSelectedCanvasNode(node.id))
            }}
            onPick={(asset) => {
              if (asset.publicPath === src) return
              primeCmsMediaAssetCache(asset)
              useEditorStore.getState().updateNodeProps(node.id, { src: asset.publicPath })
            }}
          />
        </Suspense>
      )}
    </>
  )
}
