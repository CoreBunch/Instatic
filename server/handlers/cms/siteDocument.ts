/**
 * Transactional site-document save.
 *
 *   PUT /admin/api/cms/site-document — persist the WHOLE site document
 *   (shell + pages + Visual Components + saved layouts) atomically, in ONE
 *   DB transaction. Replaces the four per-collection PUT endpoints, whose
 *   independent commits could tear a save in half (shell committed, pages
 *   failed) and whose reap-by-omission roster semantics let a stale client
 *   delete sibling sessions' rows.
 *
 * Protocol — explicit deletes, two modes:
 *   - `mode: 'incremental'` (every editor save): only changed rows +
 *     explicitly deleted ids ship. Rows the client doesn't mention are
 *     untouched, so deletion is stated intent, never inferred absence.
 *   - `mode: 'replace'` (imports, fresh-site bootstrap): the full collections
 *     ship; the server derives deletions as stored − shipped. `deleted*Ids`
 *     must be empty in this mode.
 *
 * Handler flow — three phases:
 *   1. Validate EVERYTHING outside the transaction (sanitization is CPU
 *      work; the SQLite adapter serializes every transaction through one
 *      chain). Capability diff-gates are identical to the four retired
 *      endpoints: shell changes via validateSiteWriteDiff, page changes via
 *      validatePageWriteDiff, component/layout changes + deletions require
 *      `site.structure.edit`. Pages validate VC refs against the MERGED
 *      post-save component roster (kept existing + changed in this batch),
 *      so a page referencing a component created in the same save is valid
 *      by construction — no cross-request ordering contract.
 *   2. ONE transaction: allocate the site-global sync seq (the counter-row
 *      lock serializes concurrent saves, making the conflict reads exact),
 *      run the base-seq conflict check (incremental mode — any shipped row
 *      stored NEWER than the client's base seq throws SaveConflictError,
 *      rolling everything back into a 409 + conflicts payload), write the
 *      shell ONLY when its content actually changed (so the shell seq stays
 *      an honest conflict signal), then apply components → layouts → pages
 *      (deletes first inside each, freeing slugs; see
 *      repositories/data/rows/apply.ts). The repository calls are `…InTx`
 *      functions — nesting `db.transaction` wedges the SQLite adapter's
 *      serialized chain.
 *   3. Post-commit effects: bump the publish version when a published page
 *      was deleted (never inside the transaction — the publish lock can be
 *      queued behind the transaction chain). This is also the emission point
 *      for the multi-admin live-sync plan's site events.
 *
 * Response: `{ ok: true, seq }` — the save's site-global sequence number,
 * stamped on the shell and every written/deleted row (conflict detection and
 * delta reconciliation substrate for the live-sync plan).
 */
import type { DbClient } from '../../db/client'
import { requireAnyCapability } from '../../auth/authz'
import type { CoreCapability } from '../../auth/capabilities'
import {
  applyDataRowChangesInTx,
  listDataRowIdSlugs,
  listDataRows,
  listDataRowSeqs,
  type DataRowWrite,
} from '../../repositories/data'
import {
  getDraftSite,
  getDraftSiteSeq,
  saveDraftSite,
  stampDraftSiteSeq,
} from '../../repositories/site'
import { allocateSiteSeq } from '../../repositories/syncSequence'
import { pageFromRow, pageToCells } from '../../../src/core/data/pageFromRow'
import { visualComponentFromRow, visualComponentToCells } from '../../../src/core/data/componentFromRow'
import { savedLayoutFromRow, savedLayoutToCells } from '../../../src/core/data/layoutFromRow'
import {
  SiteValidationError,
  validatePagesForPartialSave,
  validateSite,
  validateVisualComponentsForPartialWrite,
} from '@core/persistence/validate'
import { validateSavedLayoutsForPartialWrite } from '@core/persistence/validateLayouts'
import { VisualComponentSchema, vcSlugFromName, type VisualComponent } from '@core/visualComponents'
import { SavedLayoutSchema, layoutSlugFromName, type SavedLayout } from '@core/layouts'
import type { Page } from '@core/page-tree'
import { SaveConflictError, type SaveConflict } from '@core/persistence/saveConflict'
import { shellsEqual } from '@core/persistence/shellsEqual'
import type { SiteSyncActor, SiteSyncTable } from '@core/persistence/syncEvents'
import { publishSiteEvent } from '../../events/siteEvents'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { bumpPublishVersionSerialized } from '../../publish/publishState'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX } from './shared'
import { ForbiddenSiteChangeError, validateSiteWriteDiff } from './siteDiff'
import { validatePageWriteDiff } from './pageDiff'

const SITE_WRITE_CAPABILITIES = [
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
] satisfies CoreCapability[]

const SiteDocumentBodySchema = Type.Object({
  mode: Type.Union([Type.Literal('incremental'), Type.Literal('replace')]),
  // The shell — validated structurally by validateSite in phase 1.
  site: Type.Unknown(),
  // Pages are parsed/validated by validatePagesForPartialSave.
  changedPages: Type.Array(Type.Unknown()),
  deletedPageIds: Type.Array(Type.String()),
  changedComponents: Type.Array(VisualComponentSchema),
  deletedComponentIds: Type.Array(Type.String()),
  changedLayouts: Type.Array(SavedLayoutSchema),
  deletedLayoutIds: Type.Array(Type.String()),
  /**
   * Conflict detection (incremental mode): rowId → the stored seq the client
   * last synchronized with, for every changed AND deleted row. Inside the
   * save transaction, a stored row that is NEWER than its base — or that has
   * no base entry at all — 409s the whole save with a conflicts payload
   * (see @core/persistence/saveConflict). Client-created rows have no stored
   * counterpart and pass by construction. Ignored in replace mode (imports
   * are deliberate replace-everything operations).
   */
  baseSeqs: Type.Record(Type.String(), Type.Number()),
  /**
   * The shell seq the client last synchronized with. Checked only when the
   * incoming shell content actually differs from the stored shell — the
   * shell is shipped with every save, so an unconditional check would 409
   * every concurrent save pair. Ignored in replace mode.
   */
  shellBaseSeq: Type.Number(),
}, { additionalProperties: false })

type SiteDocumentBody = Static<typeof SiteDocumentBodySchema>

/**
 * Resolve one collection's deletion set for the requested mode:
 * incremental → the explicitly shipped ids; replace → stored − shipped.
 */
function resolveDeleteIds(
  mode: SiteDocumentBody['mode'],
  existingIds: Iterable<string>,
  changedIds: ReadonlySet<string>,
  explicitDeleteIds: readonly string[],
): Set<string> {
  if (mode === 'incremental') return new Set(explicitDeleteIds)
  const deletions = new Set<string>()
  for (const id of existingIds) {
    if (!changedIds.has(id)) deletions.add(id)
  }
  return deletions
}

/** 400 when a row id is both written and deleted — the client's netting rule failed. */
function findChangedDeletedOverlap(
  changedIds: ReadonlySet<string>,
  deleteIds: ReadonlySet<string>,
): string | null {
  for (const id of deleteIds) {
    if (changedIds.has(id)) return id
  }
  return null
}

/**
 * Component/layout changes and deletions are structural work — parity with
 * the retired per-collection endpoints, which rejected any non-empty write
 * for callers without `site.structure.edit`.
 */
function forbiddenStructuralChange(
  capabilities: readonly string[],
  path: string,
  changedCount: number,
  deleteIds: ReadonlySet<string>,
  label: string,
): Response | null {
  if (capabilities.includes('site.structure.edit')) return null
  if (changedCount === 0 && deleteIds.size === 0) return null
  const err = new ForbiddenSiteChangeError(
    'structure',
    path,
    deleteIds.size > 0 ? `${label} deleted ${Array.from(deleteIds).join(', ')}` : `${label} changed`,
  )
  return jsonResponse({ error: err.message, kind: err.kind, path: err.path }, { status: 403 })
}

export async function handleSiteDocumentRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/site-document`) return null
  if (req.method !== 'PUT') return methodNotAllowed()

  const user = await requireAnyCapability(req, db, SITE_WRITE_CAPABILITIES)
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, SiteDocumentBodySchema)
  if (!body) return badRequest('Invalid request body')

  if (
    body.mode === 'replace' &&
    (body.deletedPageIds.length > 0 || body.deletedComponentIds.length > 0 || body.deletedLayoutIds.length > 0)
  ) {
    return badRequest('replace mode derives deletions server-side — deleted*Ids must be empty')
  }

  try {
    // ─── Phase 1: validate everything OUTSIDE the transaction ───────────────
    //
    // Per-collection work is GATED on need so the hot path stays O(change):
    // a shell-only autosave loads no rows at all; a one-page edit loads the
    // cheap (id, slug) page projection plus the component roster it needs
    // for ref validation — never all three hydrated collections.

    const previousShell = await getDraftSite(db)
    const shell = validateSite(body.site)
    validateSiteWriteDiff(previousShell, shell, user.capabilities)

    // The shell ships with EVERY save, changed or not. Detecting "actually
    // changed" here (CPU work, outside the transaction) lets phase 2 skip the
    // shell write + seq stamp on row-only saves — which in turn keeps the
    // shell seq an honest conflict signal (an unconditional stamp would 409
    // every concurrent save pair on the shell).
    const shellChanged = previousShell === null || !shellsEqual(previousShell, shell)

    const hasAllSiteCaps =
      user.capabilities.includes('site.structure.edit') &&
      user.capabilities.includes('site.content.edit') &&
      user.capabilities.includes('site.style.edit')

    // Components — cross-VC rules (identity, refs, acyclicity) run against
    // the merged post-save roster, so the stored roster is needed whenever
    // components change or are deleted, in replace mode (derive deletions),
    // AND whenever pages change (page VC-ref validation + slot sync).
    const needsComponentRoster =
      body.changedComponents.length > 0 ||
      body.deletedComponentIds.length > 0 ||
      body.changedPages.length > 0 ||
      body.mode === 'replace'
    const existingVCs: VisualComponent[] = needsComponentRoster
      ? (await listDataRows(db, 'components')).flatMap((r) => {
          const vc = visualComponentFromRow(r)
          return vc ? [vc] : []
        })
      : []
    const changedComponentIds = new Set(body.changedComponents.map((vc) => vc.id))
    const componentDeleteIds = resolveDeleteIds(
      body.mode, existingVCs.map((vc) => vc.id), changedComponentIds, body.deletedComponentIds,
    )
    {
      const overlap = findChangedDeletedOverlap(changedComponentIds, componentDeleteIds)
      if (overlap) return badRequest(`component "${overlap}" is both changed and deleted`)
      const forbidden = forbiddenStructuralChange(
        user.capabilities, 'components', body.changedComponents.length, componentDeleteIds, 'component',
      )
      if (forbidden) return forbidden
    }
    const keptComponentIds = new Set<string>(changedComponentIds)
    for (const vc of existingVCs) {
      if (!componentDeleteIds.has(vc.id)) keptComponentIds.add(vc.id)
    }
    const components: VisualComponent[] =
      body.changedComponents.length > 0 || componentDeleteIds.size > 0
        ? validateVisualComponentsForPartialWrite(body.changedComponents, existingVCs, keptComponentIds)
        : []

    // Layouts — identity rules (unique id + name) run against the merged roster.
    const needsLayoutRoster =
      body.changedLayouts.length > 0 || body.deletedLayoutIds.length > 0 || body.mode === 'replace'
    const existingLayouts: SavedLayout[] = needsLayoutRoster
      ? (await listDataRows(db, 'layouts')).flatMap((r) => {
          const layout = savedLayoutFromRow(r)
          return layout ? [layout] : []
        })
      : []
    const changedLayoutIds = new Set(body.changedLayouts.map((l) => l.id))
    const layoutDeleteIds = resolveDeleteIds(
      body.mode, existingLayouts.map((l) => l.id), changedLayoutIds, body.deletedLayoutIds,
    )
    {
      const overlap = findChangedDeletedOverlap(changedLayoutIds, layoutDeleteIds)
      if (overlap) return badRequest(`layout "${overlap}" is both changed and deleted`)
      const forbidden = forbiddenStructuralChange(
        user.capabilities, 'layouts', body.changedLayouts.length, layoutDeleteIds, 'layout',
      )
      if (forbidden) return forbidden
    }
    const keptLayoutIds = new Set<string>(changedLayoutIds)
    for (const layout of existingLayouts) {
      if (!layoutDeleteIds.has(layout.id)) keptLayoutIds.add(layout.id)
    }
    const layouts: SavedLayout[] =
      body.changedLayouts.length > 0 || layoutDeleteIds.size > 0
        ? validateSavedLayoutsForPartialWrite(body.changedLayouts, existingLayouts, keptLayoutIds)
        : []

    // Pages — validated against the MERGED post-save VC roster so refs to
    // components created in this same save resolve, and slug uniqueness runs
    // against the kept rows (a changed page may take the slug of a page this
    // save deletes — homepage swap + delete in one batch). Slug checks only
    // need the cheap (id, slug) projection; the HYDRATED page roster is
    // loaded only for the per-category diff, which callers holding all three
    // site-write capabilities skip entirely (its fast path).
    const needsPageSlugs = body.changedPages.length > 0 || body.mode === 'replace'
    const existingPageSlugs = needsPageSlugs ? await listDataRowIdSlugs(db, 'pages') : []
    const changedPageIdsRaw = new Set(
      body.changedPages
        .map((p) => (p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string'),
    )
    const pageDeleteIds = resolveDeleteIds(
      body.mode, existingPageSlugs.map((r) => r.id), changedPageIdsRaw, body.deletedPageIds,
    )
    {
      const overlap = findChangedDeletedOverlap(changedPageIdsRaw, pageDeleteIds)
      if (overlap) return badRequest(`page "${overlap}" is both changed and deleted`)
    }
    const changedVCById = new Map(components.map((vc) => [vc.id, vc]))
    const mergedVCs: VisualComponent[] = [
      ...existingVCs.filter((vc) => keptComponentIds.has(vc.id) && !changedVCById.has(vc.id)),
      ...components,
    ]
    const keptSlugs = existingPageSlugs.filter((r) => !pageDeleteIds.has(r.id))
    const pages: Page[] =
      body.changedPages.length > 0
        ? validatePagesForPartialSave(body.changedPages, mergedVCs, keptSlugs)
        : []
    const previousPages: Page[] =
      pages.length > 0 && !hasAllSiteCaps
        ? (await listDataRows(db, 'pages')).map(pageFromRow)
        : []
    validatePageWriteDiff({
      previousPages,
      changedPages: pages,
      deletedPageIds: pageDeleteIds,
      capabilities: user.capabilities,
    })

    // ─── Phase 2: ONE transaction, dependency order enforced here ───────────

    const componentWrites: DataRowWrite[] = components.map((vc) => ({
      id: vc.id,
      cells: visualComponentToCells(vc),
      slug: vcSlugFromName(vc.name),
    }))
    const layoutWrites: DataRowWrite[] = layouts.map((layout) => ({
      id: layout.id,
      cells: savedLayoutToCells(layout),
      slug: layoutSlugFromName(layout.name),
    }))
    const pageWrites: DataRowWrite[] = pages.map((page) => ({
      id: page.id,
      cells: pageToCells(page),
      slug: page.slug,
    }))

    let seq = 0
    let deletedPublishedPage = false
    await db.transaction(async (tx) => {
      // Allocate FIRST: the counter-row UPDATE takes a row lock, so two
      // concurrent save transactions serialize here (on Postgres as well as
      // SQLite's fully-serialized chain) — which makes the conflict reads
      // below exact, not best-effort.
      seq = await allocateSiteSeq(tx)

      // Conflict check (incremental mode): any shipped row whose STORED seq
      // is newer than the client's base — or that the client has no base
      // entry for — would be a silent overwrite of another admin's work.
      // Throwing rolls the transaction back, so nothing is written on 409.
      if (body.mode === 'incremental') {
        const conflicts: SaveConflict[] = []
        if (shellChanged) {
          const storedShellSeq = await getDraftSiteSeq(tx)
          if (storedShellSeq > body.shellBaseSeq) {
            conflicts.push({ table: 'site', rowId: 'default', seq: storedShellSeq })
          }
        }
        const rowChecks = [
          { table: 'pages', ids: [...changedPageIdsRaw, ...pageDeleteIds] },
          { table: 'components', ids: [...changedComponentIds, ...componentDeleteIds] },
          { table: 'layouts', ids: [...changedLayoutIds, ...layoutDeleteIds] },
        ] as const
        for (const { table, ids } of rowChecks) {
          // listDataRowSeqs sees soft-deleted rows too: a remote deletion is
          // a newer write, not absence. Rows with no stored counterpart are
          // client creations and pass by construction (absent from the result).
          for (const stored of await listDataRowSeqs(tx, table, ids)) {
            const base = body.baseSeqs[stored.id]
            if (base === undefined || stored.seq > base) {
              conflicts.push({ table, rowId: stored.id, seq: stored.seq })
            }
          }
        }
        if (conflicts.length > 0) throw new SaveConflictError(conflicts)
      }

      // Shell write + seq stamp only when the shell content actually changed
      // — see the shellChanged comment in phase 1.
      if (shellChanged) {
        await saveDraftSite(tx, shell, user.id)
        await stampDraftSiteSeq(tx, seq)
      }
      // Empty change sets skip their table entirely — a shell-only save
      // issues no row queries inside the transaction.
      if (componentWrites.length > 0 || componentDeleteIds.size > 0) {
        await applyDataRowChangesInTx(tx, {
          tableId: 'components', writes: componentWrites, deleteIds: componentDeleteIds,
          actorUserId: user.id, seq,
        })
      }
      if (layoutWrites.length > 0 || layoutDeleteIds.size > 0) {
        await applyDataRowChangesInTx(tx, {
          tableId: 'layouts', writes: layoutWrites, deleteIds: layoutDeleteIds,
          actorUserId: user.id, seq,
        })
      }
      if (pageWrites.length > 0 || pageDeleteIds.size > 0) {
        const pagesResult = await applyDataRowChangesInTx(tx, {
          tableId: 'pages', writes: pageWrites, deleteIds: pageDeleteIds,
          actorUserId: user.id, seq,
        })
        deletedPublishedPage = pagesResult.deletedPublished
      }
    })

    // ─── Phase 3: post-commit effects ────────────────────────────────────────
    // Deleting a published page retracts its public route — invalidate the
    // render cache AFTER the transaction commits (never inside it: the bump
    // serializes against the publish lock, which itself waits on the
    // transaction chain).
    if (deletedPublishedPage) await bumpPublishVersionSerialized()

    // Live-sync fan-out — idempotent hints to every open editor socket
    // (ids + seqs only, never payloads; see @core/persistence/syncEvents).
    // A replace-mode save collapses to ONE site-reloaded event instead of
    // thousands of row events.
    const actor: SiteSyncActor = { userId: user.id, name: user.displayName || user.email }
    if (body.mode === 'replace') {
      publishSiteEvent({ kind: 'site-reloaded', seq, actor })
    } else {
      if (shellChanged) publishSiteEvent({ kind: 'shell-changed', seq, actor })
      const rowGroups: Array<{ table: SiteSyncTable; changedIds: Iterable<string>; deleteIds: Iterable<string> }> = [
        { table: 'pages', changedIds: changedPageIdsRaw, deleteIds: pageDeleteIds },
        { table: 'components', changedIds: changedComponentIds, deleteIds: componentDeleteIds },
        { table: 'layouts', changedIds: changedLayoutIds, deleteIds: layoutDeleteIds },
      ]
      for (const { table, changedIds, deleteIds } of rowGroups) {
        const changedSeqs = Object.fromEntries([...changedIds].map((id) => [id, seq]))
        if (Object.keys(changedSeqs).length > 0) {
          publishSiteEvent({ kind: 'rows-changed', table, seqs: changedSeqs, actor })
        }
        const deletedSeqs = Object.fromEntries([...deleteIds].map((id) => [id, seq]))
        if (Object.keys(deletedSeqs).length > 0) {
          publishSiteEvent({ kind: 'rows-deleted', table, seqs: deletedSeqs, actor })
        }
      }
    }

    return jsonResponse({ ok: true, seq })
  } catch (err) {
    if (err instanceof SiteValidationError) return badRequest(err.message)
    if (err instanceof ForbiddenSiteChangeError) {
      return jsonResponse(
        { error: err.message, kind: err.kind, path: err.path },
        { status: 403 },
      )
    }
    if (err instanceof SaveConflictError) {
      return jsonResponse({ error: err.message, conflicts: err.conflicts }, { status: 409 })
    }
    throw err
  }
}
