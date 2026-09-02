/**
 * Per-key promise-chain serializer. Calls for the same key run one after
 * another in arrival order; calls for different keys run concurrently. A
 * rejected call does not block the ones queued behind it. JS is
 * single-threaded, so a promise chain is a sufficient lock — the same
 * shape `withPublishLock` uses for the one global publish key.
 *
 * Used to serialize site plugin builds and lifecycle transitions per plugin
 * id: two overlapping activations must not both read the same row version,
 * derive the same next version, and race the upgrade path.
 */
export type KeyedSerializer = <T>(key: string, fn: () => Promise<T>) => Promise<T>

export function createKeyedSerializer(): KeyedSerializer {
  const chains = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve()
    const run = (): Promise<T> => fn()
    const next = previous.then(run, run)
    chains.set(key, next)
    const release = (): void => {
      if (chains.get(key) === next) chains.delete(key)
    }
    next.then(release, release)
    return next
  }
}
