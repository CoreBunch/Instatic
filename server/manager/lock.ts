/**
 * One lock for every Manager API operation that changes state on disk.
 *
 * Heavy operations (snapshot create and restore, opening and committing a
 * transfer) refuse to queue: a second one gets `409 busy`. Chunk uploads and
 * aborts wait their turn instead, so two requests can never append to the
 * same item at once and a commit can never race an upload or an abort.
 * Handlers re-read transfer state INSIDE the lock, so nothing acts on a
 * copy that another request has since replaced.
 */
let tail: Promise<void> = Promise.resolve()
/** Operations holding or waiting for the lock. */
let active = 0

/** Run `work` when the lock is free, in arrival order. */
export function serialized<T>(work: () => Promise<T>): Promise<T> {
  active += 1
  const run = tail.then(work)
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run.finally(() => {
    active -= 1
  })
}

/** Run `work` only if nothing holds or awaits the lock; otherwise return null. */
export function exclusive<T>(work: () => Promise<T>): Promise<T> | null {
  return active > 0 ? null : serialized(work)
}
