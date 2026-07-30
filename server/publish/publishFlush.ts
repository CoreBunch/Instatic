/**
 * Publish-flush seam — EVERY publish path awaits this before it reads rows,
 * so the baked output includes collab edits still inside the relay's persist
 * debounce window ("publish bakes exactly what the admins see").
 *
 * The collab relay registers its flush here at boot; publish just calls
 * `runPublishFlush()`. This keeps the dependency one-way (publish must not
 * import the relay) and makes the flush INTRINSIC to publishing rather than
 * bolted onto the one HTTP route that happened to have the relay handle —
 * per-row publish, the scheduled-publish tick, and plugin-host publish all
 * ride the same guarantee now.
 */
let flush: (() => Promise<void>) | null = null

export function registerPublishFlush(fn: () => Promise<void>): () => void {
  flush = fn
  return () => {
    if (flush === fn) flush = null
  }
}

/** Flush the collab relay (no-op before the relay registers, e.g. in tests). */
export async function runPublishFlush(): Promise<void> {
  await flush?.()
}
