/**
 * Dispatch cool-off — a self-healing circuit breaker for a plugin dispatch
 * whose handler keeps running out of its call budget.
 *
 * Every overrun costs a worker restart, and a visitor can cause one through
 * anything a request dispatches: a route, a hook filter or listener on a
 * dynamic render, a loop source in a hole, a media call. So overruns must
 * never take a plugin down for good (that would hand a visitor an off
 * switch); instead the one dispatch that keeps overrunning is held back for
 * a short, growing while and then resumes by itself. Nothing else about the
 * plugin changes.
 *
 * A dispatch is named by a key that survives a restart: `route GET:/orders`,
 * `filter publish.html`, `listener publish.before`, `loop acme.products`,
 * `media <adapterId>`, `media-url` (`dispatchKeyOf` in `workerPool.ts`).
 * Schedules and lifecycle calls have no cool-off: a visitor cannot trigger
 * them, and each has its own failure handling.
 *
 * The first overrun of a key costs nothing. From the second inside
 * `STREAK_WINDOW_MS` it cools off for 15 s, then 30 s, 60 s … capped at
 * 5 minutes. A key that stays quiet for the window starts over.
 */

/** Cool-off after the 2nd, 3rd, 4th … overrun of a streak; the last one repeats. */
const COOL_OFF_STEPS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const

/** Two overruns further apart than this are unrelated. */
const STREAK_WINDOW_MS = 10 * 60 * 1000

interface OverrunStreak {
  overruns: number
  lastOverrunAt: number
  coolsOffUntil: number
}

const streaks = new Map<string, OverrunStreak>()

function streakKey(pluginId: string, dispatchKey: string): string {
  return `${pluginId}\n${dispatchKey}`
}

/**
 * Record that the dispatch `dispatchKey` overran its budget. Returns how long
 * it now cools off, in milliseconds (0 for the first overrun of a streak).
 */
export function recordDispatchOverrun(pluginId: string, dispatchKey: string, now: number = Date.now()): number {
  const key = streakKey(pluginId, dispatchKey)
  const previous = streaks.get(key)
  const overruns = previous && now - previous.lastOverrunAt <= STREAK_WINDOW_MS ? previous.overruns + 1 : 1
  const coolOffMs = overruns < 2 ? 0 : COOL_OFF_STEPS_MS[Math.min(overruns - 2, COOL_OFF_STEPS_MS.length - 1)]
  streaks.set(key, { overruns, lastOverrunAt: now, coolsOffUntil: now + coolOffMs })
  return coolOffMs
}

/** Milliseconds left of `dispatchKey`'s cool-off, or 0 when it may be dispatched. */
export function dispatchCoolOffRemainingMs(pluginId: string, dispatchKey: string, now: number = Date.now()): number {
  const streak = streaks.get(streakKey(pluginId, dispatchKey))
  if (!streak) return 0
  if (now - streak.lastOverrunAt > STREAK_WINDOW_MS) {
    streaks.delete(streakKey(pluginId, dispatchKey))
    return 0
  }
  return Math.max(0, streak.coolsOffUntil - now)
}

/** Forget every streak of a plugin: a manual restart, an upgrade, an uninstall. */
export function clearDispatchCoolOffs(pluginId: string): void {
  const prefix = `${pluginId}\n`
  for (const key of streaks.keys()) {
    if (key.startsWith(prefix)) streaks.delete(key)
  }
}

/**
 * A dispatch that was not sent because it is cooling off. Each caller turns
 * it into that kind's failure: a route answers 503, a filter leaves its value
 * unchanged, a listener is skipped, a loop fetch and a media call fail.
 */
export class PluginDispatchCoolingOffError extends Error {
  readonly retryAfterMs: number

  constructor(pluginId: string, dispatchKey: string, retryAfterMs: number) {
    super(`Plugin "${pluginId}" ${dispatchKey} keeps running out of time and is paused for a moment. Try again.`)
    this.name = 'PluginDispatchCoolingOffError'
    this.retryAfterMs = retryAfterMs
  }
}
