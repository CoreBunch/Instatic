/**
 * Route cool-off — a self-healing circuit breaker for a plugin route whose
 * handler keeps running out of its call budget.
 *
 * Every overrun costs a worker restart, and anyone who can reach a public
 * route can cause one. So overruns must never take a plugin down for good
 * (that would hand a visitor an off switch); instead the one route that keeps
 * overrunning stops being dispatched for a short, growing while and then
 * resumes by itself. Nothing else about the plugin changes: its other routes,
 * hooks, schedules and loop sources keep running.
 *
 * The first overrun of a route costs nothing. From the second inside
 * `STREAK_WINDOW_MS` the route cools off for 15 s, then 30 s, 60 s … capped
 * at 5 minutes. A route that stays quiet for the window starts over.
 */

/** Cool-off after the 2nd, 3rd, 4th … overrun of a streak; the last one repeats. */
const COOL_OFF_STEPS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const

/** Two overruns further apart than this are unrelated. */
const STREAK_WINDOW_MS = 10 * 60 * 1000

interface RouteStreak {
  overruns: number
  lastOverrunAt: number
  coolsOffUntil: number
}

const streaks = new Map<string, RouteStreak>()

function streakKey(pluginId: string, routeKey: string): string {
  return `${pluginId}\n${routeKey}`
}

/**
 * Record that `routeKey` overran its budget. Returns how long the route now
 * cools off, in milliseconds (0 for the first overrun of a streak).
 */
export function recordRouteOverrun(pluginId: string, routeKey: string, now: number = Date.now()): number {
  const key = streakKey(pluginId, routeKey)
  const previous = streaks.get(key)
  const overruns = previous && now - previous.lastOverrunAt <= STREAK_WINDOW_MS ? previous.overruns + 1 : 1
  const coolOffMs = overruns < 2 ? 0 : COOL_OFF_STEPS_MS[Math.min(overruns - 2, COOL_OFF_STEPS_MS.length - 1)]
  streaks.set(key, { overruns, lastOverrunAt: now, coolsOffUntil: now + coolOffMs })
  return coolOffMs
}

/** Milliseconds left of `routeKey`'s cool-off, or 0 when it may be dispatched. */
export function routeCoolOffRemainingMs(pluginId: string, routeKey: string, now: number = Date.now()): number {
  const streak = streaks.get(streakKey(pluginId, routeKey))
  if (!streak) return 0
  if (now - streak.lastOverrunAt > STREAK_WINDOW_MS) {
    streaks.delete(streakKey(pluginId, routeKey))
    return 0
  }
  return Math.max(0, streak.coolsOffUntil - now)
}

/** Forget every streak of a plugin: a manual restart, an upgrade, an uninstall. */
export function clearRouteCoolOffs(pluginId: string): void {
  const prefix = `${pluginId}\n`
  for (const key of streaks.keys()) {
    if (key.startsWith(prefix)) streaks.delete(key)
  }
}
