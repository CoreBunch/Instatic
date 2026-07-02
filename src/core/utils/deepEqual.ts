/**
 * Structural deep equality for plain JSON-shaped values (objects, arrays,
 * primitives) — key order insensitive, no prototype/cycle handling (persisted
 * CMS documents are acyclic plain data by construction).
 *
 * Shared by the server's shell diff (`server/handlers/cms/siteDiff.ts`) and
 * the editor's remote-apply echo detection (`applyRemoteSnapshot` skips the
 * swap — and the undo-history clear — when the fetched remote content is
 * identical to the local copy, which is exactly what an echo of one's own
 * save looks like).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    )) return false
  }
  return true
}
