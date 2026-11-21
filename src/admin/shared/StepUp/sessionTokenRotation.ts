/**
 * "The session cookie was just replaced" — raised when a password
 * re-confirmation succeeds, because the server rotates the session token on
 * step-up.
 *
 * Anything holding a long-lived connection authenticated by the OLD cookie
 * (the site editor's collaboration socket) subscribes here and reconnects at
 * once, rather than discovering the rotation when the server refuses it.
 */
const listeners = new Set<() => void>()

export function onSessionTokenRotated(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifySessionTokenRotated(): void {
  for (const listener of listeners) listener()
}
