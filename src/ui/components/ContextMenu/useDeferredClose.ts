import { useEffect, useState } from 'react'
import { useEvent } from '@ui/lib/useEvent'

/**
 * Exit-animation duration. The menu stays mounted for this long after a
 * dismiss (Escape / outside-click) so the `data-closing` exit keyframes can
 * play before the caller unmounts it. MUST stay ≥ the `contextMenuExit`
 * animation duration in `ContextMenu.module.css`.
 */
const EXIT_DURATION_MS = 110

interface DeferredClose {
  /** True while the exit animation is playing. */
  closing: boolean
  /**
   * Begin a dismiss: flip `closing` (which applies the exit keyframes) and
   * defer the caller's `onClose` (the real unmount) by one
   * `EXIT_DURATION_MS` window. No-op while a close is already pending.
   */
  beginClose: () => void
}

/**
 * useDeferredClose — play an exit animation on a presence-mounted overlay.
 *
 * A context menu is mounted by its caller (`{open && <ContextMenu/>}`), so it
 * can't keep itself in the DOM after `onClose`. To still animate out on a
 * dismiss, this hook flips `closing` first and defers `onClose` by one
 * `EXIT_DURATION_MS` window. Reopening at a new key (the typical
 * right-click-elsewhere flow) cancels the pending unmount so the menu settles
 * at its new location instead of vanishing — pass the position/anchor inputs
 * as `resetKeys`.
 *
 * When `enabled` is false the hook is a pass-through: `beginClose` calls
 * `onClose` synchronously and `closing` never flips. This keeps the instant
 * close that anchored dropdowns (Select, combobox) rely on; only the
 * right-click context menus opt into the deferred exit animation.
 *
 * State transitions follow the derive-from-props pattern (the same one
 * `useDelayedUnmount` uses): the reset is detected during render, never via a
 * setState-in-effect, and the deferred-unmount timer lives in an effect keyed
 * on `closing` so its cleanup fires the moment a reopen flips `closing` back
 * to false.
 */
export function useDeferredClose(
  onClose: () => void,
  enabled: boolean,
  resetKeys: readonly unknown[],
): DeferredClose {
  const [closing, setClosing] = useState(false)
  const [prevKeys, setPrevKeys] = useState(resetKeys)

  const keysChanged =
    resetKeys.length !== prevKeys.length ||
    resetKeys.some((key, i) => !Object.is(key, prevKeys[i]))
  if (keysChanged) {
    setPrevKeys(resetKeys)
    if (closing) setClosing(false)
  }

  // Latest-onClose snapshot so the timer effect doesn't re-subscribe when the
  // caller passes a fresh handler identity each render.
  const fireClose = useEvent(onClose)

  const beginClose = useEvent(() => {
    if (!enabled) {
      fireClose()
      return
    }
    setClosing(true)
  })

  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(fireClose, EXIT_DURATION_MS)
    return () => clearTimeout(timer)
  }, [closing, fireClose])

  return { closing, beginClose }
}
