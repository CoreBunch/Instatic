/**
 * Collab document addressing — one Yjs document per logical row/shell.
 *
 * The doc id is the unit the whole collaboration stack speaks: the client
 * provider binds by doc id, the server relay registers and persists by doc
 * id, the wire protocol prefixes every frame with it, and the
 * `collab_documents` table keys on it.
 */

export type CollabDocKind = 'site' | 'page' | 'component' | 'layout'

export interface CollabDocId {
  kind: CollabDocKind
  /** The backing row id; the shell uses the fixed site row id `default`. */
  rowId: string
  /** Absent for shared structure; present for one independently editable translation. */
  localeId?: string
}

export const SITE_DOC_ID = 'site:default'

export function encodeCollabDocId(id: CollabDocId): string {
  if (id.localeId !== undefined) {
    if (id.kind === 'site') throw new Error('The site shell has no locale document.')
    return `localization:${id.kind}:${encodeURIComponent(id.rowId)}:${encodeURIComponent(id.localeId)}`
  }
  return `${id.kind}:${id.rowId}`
}

const KINDS: readonly CollabDocKind[] = ['site', 'page', 'component', 'layout']

export function parseCollabDocId(raw: string): CollabDocId | null {
  if (raw.startsWith('localization:')) {
    const parts = raw.split(':')
    if (parts.length !== 4 || !['page', 'component', 'layout'].includes(parts[1])) return null
    try {
      const rowId = decodeURIComponent(parts[2])
      const localeId = decodeURIComponent(parts[3])
      if (!rowId || !localeId) return null
      return { kind: parts[1] as CollabDocKind, rowId, localeId }
    } catch (_error) {
      // Invalid percent escapes are an invalid wire document address.
      return null
    }
  }
  const sep = raw.indexOf(':')
  if (sep <= 0) return null
  const kind = raw.slice(0, sep)
  const rowId = raw.slice(sep + 1)
  if (!rowId || !KINDS.includes(kind as CollabDocKind)) return null
  return { kind: kind as CollabDocKind, rowId }
}

/** Localized documents follow their logical row's shared roster membership. */
export function sharedCollabDocId(raw: string): string {
  const parsed = parseCollabDocId(raw)
  return parsed ? encodeCollabDocId({ kind: parsed.kind, rowId: parsed.rowId }) : raw
}
