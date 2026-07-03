/**
 * Per-category capability enforcement for relay writes.
 *
 * The HTTP save path diff-validates every batch by category (structure /
 * content / style — `validateSiteWriteDiff` + `validatePageWriteDiff`).
 * Relay writes arrive as opaque Yjs updates, so the guard makes them
 * diff-able: fork the authoritative doc, apply the update to the fork,
 * project BOTH sides back to the JSON domain, and run the SAME validators
 * the HTTP path uses. One enforcement vocabulary, two transports.
 *
 * Full site-writers (all three capabilities) skip the guard entirely — the
 * fork+project cost is only paid by partial-capability connections, whose
 * human-scale edit rate makes it negligible.
 *
 * Component and layout docs follow the HTTP rule wholesale: ANY change to
 * them is structural work. On the site doc, roster membership/order changes
 * are structural; the shell diff-validates per field.
 */
import * as Y from 'yjs'
import type { SiteShell } from '@core/page-tree'
import { deepEqual } from '@core/utils/deepEqual'
import {
  parseCollabDocId,
  projectComponentDoc,
  projectLayoutDoc,
  projectPageDoc,
  projectSiteDoc,
} from '@core/collab'
import type { CoreCapability } from '@core/capabilities'
import { ForbiddenSiteChangeError, validateSiteWriteDiff } from '../handlers/cms/siteDiff'
import { validatePageWriteDiff } from '../handlers/cms/pageDiff'

export type UpdateGuardVerdict = { ok: true } | { ok: false; reason: string }

function hasStructure(capabilities: readonly CoreCapability[]): boolean {
  return capabilities.includes('site.structure.edit')
}

/** Projections omit the non-collaborative shell fields — pin them for the diff. */
function asShell(shell: Record<string, unknown>): SiteShell {
  return { ...shell, id: 'default', updatedAt: 0 } as unknown as SiteShell
}

/**
 * Validate one incoming update against the connection's capabilities.
 * Never mutates `doc` — the caller applies the update only on `ok: true`.
 */
export function validateGuardedUpdate(
  docId: string,
  doc: Y.Doc,
  update: Uint8Array,
  capabilities: readonly CoreCapability[],
): UpdateGuardVerdict {
  const parsed = parseCollabDocId(docId)
  if (!parsed) return { ok: false, reason: `unknown doc id ${docId}` }

  const fork = new Y.Doc()
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
  try {
    Y.applyUpdate(fork, update)
  } catch (err) {
    return { ok: false, reason: `malformed update: ${err instanceof Error ? err.message : String(err)}` }
  }

  try {
    if (parsed.kind === 'page') {
      const previous = projectPageDoc(doc, parsed.rowId)
      const next = projectPageDoc(fork, parsed.rowId)
      validatePageWriteDiff({
        // An unseeded previous (no root yet) means this update CREATES the
        // page content — validatePageWriteDiff treats a missing previous as
        // a structural page creation.
        previousPages: previous.rootNodeId ? [previous] : [],
        changedPages: [next],
        deletedPageIds: new Set(),
        capabilities,
      })
      return { ok: true }
    }

    if (parsed.kind === 'component' || parsed.kind === 'layout') {
      const previous =
        parsed.kind === 'component'
          ? projectComponentDoc(doc, parsed.rowId)
          : projectLayoutDoc(doc, parsed.rowId)
      const next =
        parsed.kind === 'component'
          ? projectComponentDoc(fork, parsed.rowId)
          : projectLayoutDoc(fork, parsed.rowId)
      if (!deepEqual(previous, next) && !hasStructure(capabilities)) {
        return {
          ok: false,
          reason: `${parsed.kind} changes require site.structure.edit`,
        }
      }
      return { ok: true }
    }

    // Site doc: roster membership/order is structural; the shell diff
    // validates per category, exactly like the HTTP path.
    const previous = projectSiteDoc(doc)
    const next = projectSiteDoc(fork)
    if (!deepEqual(previous.rosters, next.rosters) && !hasStructure(capabilities)) {
      return { ok: false, reason: 'roster changes require site.structure.edit' }
    }
    validateSiteWriteDiff(
      // An empty previous shell = unseeded doc being populated — the diff
      // validator treats a null previous as full-shell creation.
      Object.keys(previous.shell).length === 0 ? null : asShell(previous.shell),
      asShell(next.shell),
      capabilities,
    )
    return { ok: true }
  } catch (err) {
    if (err instanceof ForbiddenSiteChangeError) {
      return { ok: false, reason: err.message }
    }
    throw err
  }
}
