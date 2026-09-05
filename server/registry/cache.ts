/**
 * Bounded TTL cache with single-flight loading for upstream registry reads.
 *
 * Search-as-you-type from several admins would otherwise hammer the registry
 * with identical requests; a repeat lookup inside the TTL is served from
 * memory, and concurrent misses for one key share one in-flight promise.
 * One TTL per cache means insertion order is expiry order: every insert
 * sweeps the expired head, and the oldest entry goes once `maxEntries` is
 * exceeded. Hits do not reorder entries, so the sweep's "stop at the first
 * live entry" stays correct.
 */
interface Entry<T> {
  value: T
  expiresAt: number
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly inFlight = new Map<string, Promise<T>>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly now: () => number
  /** Bumped by `clear()`; a load that started before it must not write its result back. */
  private generation = 0

  constructor(maxEntries: number, ttlMs: number, now: () => number = Date.now) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.now = now
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
    this.sweep()
  }

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key)
    if (cached !== undefined) return cached
    const pending = this.inFlight.get(key)
    if (pending) return pending
    const startedAt = this.generation
    const promise = loader()
      .then((value) => {
        // A `clear()` while this was in flight means the caller wanted a cold
        // cache (a test swapping the transport); don't repopulate it.
        if (startedAt === this.generation) this.set(key, value)
        return value
      })
      .finally(() => {
        // Only retire our own entry: a `clear()` mid-flight may already have
        // let a newer load register under this key.
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
      })
    this.inFlight.set(key, promise)
    return promise
  }

  clear(): void {
    this.generation++
    this.entries.clear()
    this.inFlight.clear()
  }

  /**
   * Drop expired entries from the oldest end, then enforce the entry cap.
   * Entries are in insertion (= expiry) order, so the scan stops at the first
   * live entry: the cost is proportional to what actually expired.
   */
  private sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) break
      this.entries.delete(key)
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
