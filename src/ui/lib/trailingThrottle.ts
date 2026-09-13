/**
 * Leading + trailing throttle for burst-prone callbacks (a native color
 * input fires onChange per pointermove during a picker drag). The first call
 * in a quiet period fires immediately so single clicks stay instant; calls
 * inside the window coalesce to one trailing fire with the LATEST arguments.
 */
import { useEffect, useState } from 'react'
import { useEvent } from './useEvent'

export interface TrailingThrottle<A extends unknown[]> {
  call: (...args: A) => void
  /** Fire any pending trailing call now (used on unmount so nothing is lost). */
  flush: () => void
}

export function createTrailingThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): TrailingThrottle<A> {
  let lastFiredAt = 0
  let pending: A | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const fire = (args: A): void => {
    lastFiredAt = Date.now()
    fn(...args)
  }

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending) {
      const args = pending
      pending = null
      fire(args)
    }
  }

  const call = (...args: A): void => {
    const elapsed = Date.now() - lastFiredAt
    if (elapsed >= ms && pending === null) {
      fire(args)
      return
    }
    pending = args
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        const queued = pending
        pending = null
        if (queued) fire(queued)
      }, Math.max(0, ms - elapsed))
    }
  }

  return { call, flush }
}

/**
 * Hook wrapper: a stable throttled callback that always invokes the latest
 * `fn`, flushing any pending trailing call on unmount.
 */
export function useTrailingThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  const stableFn = useEvent(fn)

  // useState's lazy initializer gives one stable throttle per mount; the
  // useEvent wrapper keeps it invoking the latest `fn`.
  const [throttle] = useState(() => createTrailingThrottle<A>(stableFn, ms))

  // Flush (not drop) the trailing call on unmount so a drag's final value
  // still commits when the control disappears mid-gesture.
  useEffect(() => () => throttle.flush(), [throttle])

  return throttle.call
}
