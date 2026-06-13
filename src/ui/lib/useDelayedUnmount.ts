/**
 * useDelayedUnmount — keep a component mounted for the duration of an
 * exit animation, then unmount.
 *
 * Without this, an `open={false}` prop unmounts the component instantly
 * and any CSS exit animation never plays — the element disappears
 * before the animation has a chance to run. This hook:
 *
 *   1. Mounts the component immediately when `open` flips to `true`.
 *   2. When `open` flips to `false`, sets `exiting = true` (so the
 *      caller can apply an `.exiting` class that plays the reverse
 *      animation) and schedules unmount after `durationMs`.
 *   3. Returns `{ mounted, exiting }` so the caller can branch JSX on
 *      the lifecycle:
 *
 *      ```tsx
 *      const { mounted, exiting } = useDelayedUnmount(open, 220)
 *      if (!mounted) return null
 *      return <div className={cn(styles.panel, exiting && styles.exiting)}>…</div>
 *      ```
 *
 * `durationMs` MUST be ≥ the CSS animation's longest duration. If it's
 * shorter, the element unmounts mid-animation. We don't introspect the
 * CSS — the caller knows their stylesheet.
 *
 * Reduced-motion handling: callers should disable the exit animation in
 * `@media (prefers-reduced-motion: reduce)` like they already do for
 * the entrance animation; this hook still keeps the element mounted
 * briefly, which is harmless.
 */
import { useEffect, useState } from 'react'

interface DelayedUnmountState {
  /** True while the component should be in the DOM (open or exiting). */
  mounted: boolean
  /** True while the exit animation is playing. False during the entrance and at rest. */
  exiting: boolean
}

export function useDelayedUnmount(open: boolean, durationMs: number): DelayedUnmountState {
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  /**
   * Mirror of the most recent `open` prop seen during render. Reading
   * `open` directly each render is fine, but React forbids using a
   * regular variable to detect a prop change across renders — we need
   * a state slot or a ref. This is the "deriving state from props"
   * pattern from the React docs: when the prop changes between
   * renders, we update local state inline before the render commits,
   * and React schedules a follow-up render with the new state. No
   * `useEffect` involved, no `react-hooks/set-state-in-effect` warning.
   */
  const [prevOpen, setPrevOpen] = useState(open)

  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      // false → true: mount immediately, cancel any pending exit.
      setMounted(true)
      setExiting(false)
    } else if (mounted) {
      // true → false while currently mounted: start the exit animation.
      // The actual `setMounted(false)` happens in the timer callback
      // below — that's fired by `setTimeout`, not synchronously inside
      // a `useEffect` body, so it sits outside the lint rule's
      // restriction on setState-in-effect.
      setExiting(true)
    }
  }

  useEffect(() => {
    if (!exiting) return
    const t = setTimeout(() => {
      setMounted(false)
      setExiting(false)
    }, durationMs)
    return () => clearTimeout(t)
  }, [exiting, durationMs])

  return { mounted, exiting }
}
