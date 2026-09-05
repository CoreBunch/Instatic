/**
 * Site assembly — the projected site shell (settings, style rules, files, …)
 * plus its rosters turned into the next `SiteDocument` for the store, with
 * every row the store already holds kept by reference.
 *
 * The shell is untyped wire data, so it is validated before it enters the
 * store, exactly like the HTTP load path and the relay's persist path do.
 * `validateSite` is tolerant of individual malformed entries (drops bad style
 * rules / conditions / files rather than rejecting the whole shell), so one
 * corrupt rule from any source cannot crash a panel; a shell that is not yet
 * coherent (mid-sync) fails validation and the assembly is skipped for this
 * tick. `id` / `updatedAt` are non-collaborative and injected like the
 * persist path does.
 *
 * Roster members the store does not hold are projected from their doc when
 * it already has content; a member whose doc is still empty (a peer created
 * the row and this client has not bound it yet) is bound through `bindRowDoc`
 * and joins the site once its content arrives (see `collabBinding.ts`).
 */
import type { Page, SiteDocument, SiteShell } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { encodeCollabDocId, type projectSiteDoc } from '@core/collab'
import { clonePackageJson } from '@core/site-dependencies/manifest'
import { cloneSiteRuntimeConfig } from '@core/site-runtime'
import { validateSite } from '@core/persistence/validate'

export interface SiteAssemblyInput {
  /** The store's current site — the source of every row kept by reference. */
  site: SiteDocument
  projected: ReturnType<typeof projectSiteDoc>
  /** A row projected from its (content-bearing) doc, or null while it is empty. */
  rowFromDoc: (docId: string) => Page | VisualComponent | SavedLayout | null
  /** Bind a roster member's doc on demand; its sync completes the assembly later. */
  bindRowDoc: (docId: string) => void
}

export interface AssembledSite {
  site: SiteDocument
  packageJson: SiteDocument['packageJson']
  siteRuntime: SiteDocument['runtime']
}

export function assembleSiteFromShell({
  site,
  projected,
  rowFromDoc,
  bindRowDoc,
}: SiteAssemblyInput): AssembledSite | null {
  let shell: SiteShell
  try {
    shell = validateSite({
      ...projected.shell,
      id: 'default',
      updatedAt:
        typeof projected.shell.updatedAt === 'number' ? projected.shell.updatedAt : Date.now(),
    })
  } catch (err) {
    console.warn('[collabBinding] projected shell failed validation — projection skipped:', err)
    return null
  }
  const byId = {
    pages: new Map(site.pages.map((p) => [p.id, p])),
    components: new Map(site.visualComponents.map((vc) => [vc.id, vc])),
    layouts: new Map(site.layouts.map((l) => [l.id, l])),
  }
  const assemble = <T extends { id: string }>(
    ids: readonly string[],
    existing: Map<string, T>,
    kind: 'page' | 'component' | 'layout',
  ): T[] => {
    const rows: T[] = []
    for (const id of ids) {
      const known = existing.get(id)
      if (known) {
        rows.push(known)
        continue
      }
      const rowDocId = encodeCollabDocId({ kind, rowId: id })
      const fresh = rowFromDoc(rowDocId) as T | null
      if (fresh) {
        rows.push(fresh)
        continue
      }
      bindRowDoc(rowDocId)
    }
    return rows
  }
  const nextSite: SiteDocument = {
    ...site,
    ...shell,
    pages: assemble(projected.rosters.pages, byId.pages, 'page'),
    visualComponents: assemble(projected.rosters.components, byId.components, 'component'),
    layouts: assemble(projected.rosters.layouts, byId.layouts, 'layout'),
  }
  if (projected.shell.conditions === undefined) delete nextSite.conditions
  const packageJson = clonePackageJson(nextSite.packageJson)
  const siteRuntime = cloneSiteRuntimeConfig(nextSite.runtime)
  return { site: { ...nextSite, packageJson, runtime: siteRuntime }, packageJson, siteRuntime }
}
