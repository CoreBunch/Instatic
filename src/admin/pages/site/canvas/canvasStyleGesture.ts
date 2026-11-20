import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

interface CanvasDragCallbacks {
  move: (event: PointerEvent) => void
  end: () => void
  cancel: () => void
}

/** Keep a captured canvas handle tied to its pointer and the original edit target. */
export function useCanvasStyleGesture(targetKey: string | undefined) {
  const cancelRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { cancelRef.current?.() }, [targetKey])

  return (event: ReactPointerEvent<HTMLElement>, callbacks: CanvasDragCallbacks) => {
    if (event.button !== 0 || !event.isPrimary || cancelRef.current) return
    const handle = event.currentTarget
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    event.preventDefault()
    event.stopPropagation()

    function detach() {
      cancelRef.current = null
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', interrupt)
      handle.removeEventListener('lostpointercapture', interrupt)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', onKey, true)
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
    }
    function move(next: PointerEvent) {
      if (next.pointerId === pointerId) callbacks.move(next)
    }
    function finish(next: PointerEvent) {
      if (next.pointerId !== pointerId) return
      detach()
      callbacks.end()
    }
    function cancel() {
      detach()
      callbacks.cancel()
    }
    function interrupt(next: PointerEvent) {
      if (next.pointerId === pointerId) cancel()
    }
    function onKey(key: KeyboardEvent) {
      if (key.key !== 'Escape') return
      key.stopPropagation()
      cancel()
    }

    cancelRef.current = cancel
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', interrupt)
    handle.addEventListener('lostpointercapture', interrupt)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', onKey, true)
  }
}
