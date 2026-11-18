/**
 * Output watch — "did every plugin stay available while this was rendered?"
 *
 * A page, a hole fragment or a whole bake is built from plugin output: hook
 * filters, hook listeners, loop sources, media calls. When a plugin's worker
 * is torn down, or one of its dispatches is being held back (cool-off), that
 * output is missing from whatever was rendered meanwhile, and nothing in the
 * rendered HTML says so. Rendering it once for one visitor is acceptable;
 * keeping it is not. So anything that would CACHE or BAKE a render watches
 * the span of the render and discards the result when it was disturbed:
 * the Layer B render cache (`server/publish/renderCache.ts`) and the site
 * bake (`server/publish/publishSite.ts`).
 *
 * Only plugins that contribute to rendered output count: one that registers
 * routes alone can be restarted without disturbing any render.
 */

let disruptions = 0

/** Plugins whose worker was torn down and is not back yet, with a count of overlapping recoveries. */
const recovering = new Map<string, number>()

/** A dispatch was skipped, or a worker with output registrations was torn down. */
export function notePluginOutputDisruption(): void {
  disruptions += 1
}

/** A plugin that contributes to rendered output is being recovered. Returns the "done" callback. */
export function beginOutputPluginRecovery(pluginId: string): () => void {
  disruptions += 1
  recovering.set(pluginId, (recovering.get(pluginId) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const left = (recovering.get(pluginId) ?? 1) - 1
    if (left > 0) recovering.set(pluginId, left)
    else recovering.delete(pluginId)
  }
}

/**
 * Start watching. `disrupted()` is true when, at any point since, plugin
 * output may have been missing from a render.
 */
export function watchPluginOutput(): { disrupted: () => boolean } {
  const before = disruptions
  const recoveringAtStart = recovering.size > 0
  return { disrupted: () => recoveringAtStart || disruptions !== before || recovering.size > 0 }
}

/** Wait until no output plugin is being recovered, or `timeoutMs` has passed. */
export async function untilOutputPluginsRecovered(timeoutMs: number): Promise<void> {
  const giveUpAt = Date.now() + timeoutMs
  while (recovering.size > 0 && Date.now() < giveUpAt) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}
