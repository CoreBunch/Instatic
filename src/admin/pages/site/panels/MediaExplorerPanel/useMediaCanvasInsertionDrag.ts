import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { registry } from '@core/module-engine'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import {
  dropPreviewStyle,
  resolveCanvasPointerInsertionDrop,
  type CanvasDropPreview,
} from '@site/canvas/canvasInsertionDrop'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from '@site/canvas/canvasPointerRelay'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { mediaCanvasInsertionForAsset, type MediaCanvasInsertion } from './mediaCanvasInsertion'

export interface MediaCanvasDragState {
  asset: CmsMediaAsset
  insertion: MediaCanvasInsertion
  x: number
  y: number
  preview: CanvasDropPreview | null
}

const DRAG_THRESHOLD_PX = 6

export function useMediaCanvasInsertionDrag() {
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const insertModule = useInsertModule()
  const suppressClickRef = useRef(false)
  const removeListenersRef = useRef<(() => void) | null>(null)
  const [drag, setDrag] = useState<MediaCanvasDragState | null>(null)

  const shouldSuppressClick = () => suppressClickRef.current

  useEffect(() => {
    return () => {
      removeListenersRef.current?.()
      removeListenersRef.current = null
      clearCanvasPointerRelay()
    }
  }, [])

  const handlePointerDown = (
    asset: CmsMediaAsset,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return
    const insertion = mediaCanvasInsertionForAsset(asset)
    if (!insertion) return

    const startX = event.clientX
    const startY = event.clientY
    let started = false

    const resolveDrop = (clientX: number, clientY: number) => {
      if (!canvasPage) return null
      return resolveCanvasPointerInsertionDrop({
        canvasPage,
        clientX,
        clientY,
        label: `Drop ${insertion.name.toLowerCase()}`,
      })
    }

    const move = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return
        started = true
      }

      const resolved = resolveDrop(moveEvent.clientX, moveEvent.clientY)
      setDrag({
        asset,
        insertion,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        preview: resolved?.preview ?? null,
      })
    }

    const up = (upEvent: PointerEvent) => {
      removeListenersRef.current?.()
      removeListenersRef.current = null
      clearCanvasPointerRelay()

      const resolved = started ? resolveDrop(upEvent.clientX, upEvent.clientY) : null
      setDrag(null)
      if (!started) return

      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)

      if (!resolved) return

      const mod = registry.get(insertion.moduleId)
      if (!mod) return

      const insertedNodeId = insertModule(mod, resolved.location, { defaults: insertion.defaults })
      if (insertedNodeId) {
        setActiveBreakpoint(resolved.breakpointId)
      }
    }

    const cancel = () => {
      removeListenersRef.current?.()
      removeListenersRef.current = null
      clearCanvasPointerRelay()
      setDrag(null)
    }

    removeListenersRef.current?.()
    markCanvasPointerRelay(event.pointerId)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    removeListenersRef.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }

  return {
    drag,
    handlePointerDown,
    shouldSuppressClick,
  }
}

export function mediaDropPreviewStyle(preview: CanvasDropPreview): CSSProperties {
  return dropPreviewStyle(preview)
}

export function mediaDragGhostStyle(drag: MediaCanvasDragState): CSSProperties {
  return {
    '--ghost-x': `${drag.x}px`,
    '--ghost-y': `${drag.y}px`,
  } as CSSProperties
}
