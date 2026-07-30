/**
 * Collab write gate — which bound docs are past their first sync, and how to
 * wait for that.
 *
 * A doc bound through the provider starts unsynced, and site writes are
 * refused wholesale while ANY bound doc is in that state: writing into an
 * unseeded doc would duplicate server content on merge. The window is
 * sub-second, so interactive editing never notices it.
 *
 * Programmatic callers do. A tool chain that creates a page and immediately
 * fills it lands inside the window nearly every time, and a refused write
 * reaches neither the relay nor the database — so such callers wait on
 * {@link whenCollabWritable} before mutating rather than reporting a success
 * the server never saw.
 *
 * This module owns only the gate registry. `collabBinding` owns the docs.
 */

export interface ProviderGate {
  synced: boolean
  /** Resolves on this doc's first sync. */
  whenSynced: Promise<unknown>
}

const providerGates = new Map<string, ProviderGate>()

/** True once a provider is attached — gates are meaningless in detached mode. */
let gatesActive = false

export function setGatesActive(active: boolean): void {
  gatesActive = active
}

export function registerProviderGate(docId: string, whenSynced: Promise<unknown>): ProviderGate {
  const gate: ProviderGate = { synced: false, whenSynced }
  providerGates.set(docId, gate)
  return gate
}

export function hasProviderGate(docId: string): boolean {
  return providerGates.has(docId)
}

export function clearProviderGates(): void {
  providerGates.clear()
}

/** True when at least one bound doc has not finished its first sync. */
export function anyGateUnsynced(): boolean {
  for (const gate of providerGates.values()) {
    if (!gate.synced) return true
  }
  return false
}

/**
 * Resolves once every bound doc is past its first sync — the moment site
 * writes stop being refused with `syncing`.
 *
 * Resolves `false` if the deadline passes with docs still unsynced, so the
 * caller reports a real failure instead of writing into a store the server
 * will never agree with.
 */
export async function whenCollabWritable(timeoutMs = 15_000): Promise<boolean> {
  if (!gatesActive) return true
  const deadline = Date.now() + timeoutMs
  // Re-read the registry each pass: waiting on one doc can bind further docs.
  for (;;) {
    const pending = [...providerGates.values()].filter((gate) => !gate.synced)
    if (pending.length === 0) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await Promise.race([
      Promise.all(pending.map((gate) => gate.whenSynced)),
      new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining))),
    ])
  }
}
