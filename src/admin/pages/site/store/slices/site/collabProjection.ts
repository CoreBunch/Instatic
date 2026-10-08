import type { Page, SiteDocument, SiteShell } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { encodeCollabDocId, parseCollabDocId, projectComponentDoc, projectLayoutDoc, projectPageDoc, projectSiteDoc, type CollabDocSet } from '@core/collab'
import { clonePackageJson } from '@core/site-dependencies/manifest'
import { cloneSiteRuntimeConfig } from '@core/site-runtime'
import { validateSite } from '@core/persistence/validate'

interface ProjectionContext {
  getDoc: CollabDocSet['get']
  branchId: string
  bindDoc: (docId: string) => void
}

function rowFromDoc(docId: string, context: ProjectionContext): Page | VisualComponent | SavedLayout | null {
  const parsed = parseCollabDocId(docId)
  if (!parsed || parsed.kind === 'site') return null
  const doc = context.getDoc(docId)
  if (!doc) return null
  if (parsed.kind === 'page') {
    const page = projectPageDoc(doc, parsed.rowId)
    return page.rootNodeId ? page : null
  }
  if (parsed.kind === 'component') {
    const vc = projectComponentDoc(doc, parsed.rowId)
    return vc.tree.rootNodeId ? vc : null
  }
  const layout = projectLayoutDoc(doc, parsed.rowId)
  return layout.rootNodeId ? layout : null
}

export function projectCollabDocument(site: SiteDocument, docId: string, context: ProjectionContext): SiteDocument {
  const parsed = parseCollabDocId(docId)
  if (!parsed) return site

  if (parsed.kind === 'site') {
    const doc = context.getDoc(docId)
    if (!doc) return site
    const projected = projectSiteDoc(doc)
    if (Object.keys(projected.shell).length === 0) return site
    // The projected shell is untyped wire data — validate it before it enters
    // the store, exactly like the HTTP load path (validateSite) and the relay's
    // persist path both do. `validateSite` is tolerant of individual malformed
    // entries (drops bad style rules / conditions / files rather than
    // rejecting the whole shell), so one corrupt rule from any source can't
    // crash a panel. `id`/`updatedAt` are non-collaborative — inject them like
    // the persist path. If the shell is not yet coherent (mid-sync), skip this
    // tick; the next projection re-runs once it is.
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
      return site
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
        const rowDocId = encodeCollabDocId({ kind, branchId: context.branchId, rowId: id })
        const fresh = rowFromDoc(rowDocId, context) as T | null
        if (fresh) {
          rows.push(fresh)
          continue
        }
        // A peer created this row — its doc isn't bound here yet. Bind it;
        // the whenSynced hook re-projects the site once content arrives.
        context.bindDoc(rowDocId)
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
    return { ...nextSite, packageJson, runtime: siteRuntime }
  }

  const row = rowFromDoc(docId, context)
  const collection =
    parsed.kind === 'page' ? 'pages' : parsed.kind === 'component' ? 'visualComponents' : 'layouts'
  const rows = site[collection] as Array<{ id: string }>
  const index = rows.findIndex((r) => r.id === parsed.rowId)
  if (!row) {
    if (index === -1) return site
    const nextRows = rows.filter((r) => r.id !== parsed.rowId)
    return { ...site, [collection]: nextRows } as SiteDocument
  }
  const nextRows = index === -1 ? [...rows, row] : rows.map((r, i) => (i === index ? row : r))
  return { ...site, [collection]: nextRows } as SiteDocument
}

