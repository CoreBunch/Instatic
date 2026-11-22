/**
 * commitImportPlan — the commit half of the Super Import pipeline.
 *
 * Applies a (conflict-resolved) `ImportPlan` to the site via the adapter:
 *
 *   Step A: Upload assets via `adapter.uploadAsset`. Collect `sourcePath → newUrl`.
 *   Step B: Rewrite the plan with `applyAssetRewrites`; install Google fonts.
 *   Step C: ONE `adapter.commit` call that adds all pages + style rules.
 *
 * Atomicity:
 *   Asset uploads (Step A) are additive — if the process aborts mid-upload,
 *   the already-uploaded assets remain in the media library. They are harmless
 *   (unused orphans) and will be reaped by a future background sweep. Per-asset
 *   failures are recorded as warnings and the rest continue — one bad file
 *   never aborts the import. An upload that succeeded but could not be filed
 *   under its folder still counts as uploaded: its URL is rewritten and the
 *   adapter's non-fatal notes join the warnings. The store mutation (Step C)
 *   is a single `adapter.commit` call that the admin side executes as one
 *   history snapshot — Cmd+Z reverts the entire import in one step.
 *
 * Cancellation:
 *   `options.signal` aborts the run at the next boundary — before each asset
 *   upload, each font install, and before the store commit — and an aborted
 *   in-flight upload rethrows instead of degrading to a warning. Aborting
 *   after Step C has started has no effect: the commit is atomic.
 *
 * Each commit concern (tokens, fonts, rules, pages, page-scoped files) is a
 * named function below; the transaction recipe is straight-line calls.
 */

import { nanoid } from 'nanoid'
import { isAbortError } from '@core/http'
import type { FontEntry } from '@core/fonts'
import { applyAssetRewrites } from './applyAssetRewrites'
import { rewriteInternalLinks } from './linkRewrite'
import { importSourceHash } from './siteFilePaths'
import type {
  ImportColorToken,
  ImportFontToken,
  ImportPlan,
  ImportResult,
  ImportScript,
  ImportStylesheet,
} from './types'
import type {
  FileConflict,
  PageConflict,
  RuleConflict,
  TokenConflict,
} from './conflictTypes'
import type { ImportWarning } from './warnings'
import type { SiteImportAdapter, SiteImportTransaction } from './adapter'

export interface CommitImportPlanOptions {
  /**
   * Cancels the run: no further uploads or font installs start, the in-flight
   * upload aborts, and the store commit never happens. Already-uploaded assets
   * stay in the media library — the caller reports them to the user.
   */
  signal?: AbortSignal
}

export async function commitImportPlan(
  plan: ImportPlan,
  adapter: SiteImportAdapter,
  options: CommitImportPlanOptions = {},
): Promise<ImportResult> {
  const { signal } = options

  // ── Step A: upload all assets ─────────────────────────────────────────────
  const { rewriteMap, warnings: uploadWarnings } = await uploadPlanAssets(plan, adapter, signal)

  // ── Step B: rewrite plan URLs + install Google fonts ──────────────────────
  const rewrittenPlan = applyAssetRewrites(plan, rewriteMap)
  const { installedGoogleFonts, warnings: fontInstallWarnings } =
    await installPlanGoogleFonts(rewrittenPlan, adapter, signal)

  // ── Step C: commit pages + style rules (single atomic transaction) ────────
  // Conflict resolution lookup maps (source → resolution).
  const pageConflictsBySource = new Map<string, PageConflict>(
    rewrittenPlan.conflicts.pages.map((c) => [c.source, c]),
  )
  const ruleConflictsByName = new Map<string, RuleConflict>(
    rewrittenPlan.conflicts.rules.map((c) => [c.desiredName, c]),
  )
  // Token conflicts keyed by `${kind}:${variable}`. Only `overwrite` is handled
  // here — `skip` and rename were already applied to plan.colors/fontTokens by
  // applyConflictResolutions (skip drops the token; rename gives it a unique
  // name and rewrites its `var(--x)` references).
  const tokenConflictByKey = new Map<string, TokenConflict>(
    rewrittenPlan.conflicts.tokens.map((c) => [`${c.kind}:${c.desiredVariable}`, c]),
  )

  const pageIdBySource = mintPageIds(rewrittenPlan, pageConflictsBySource)
  const linkedPages = rewriteInternalLinks(rewrittenPlan.pages, pageIdBySource)

  const results: CommitResults = {
    pages: [],
    styleRules: [],
    fonts: [],
    colors: [],
    fontTokens: [],
    scripts: [],
    stylesheets: [],
  }

  // Notes the store raises while committing (an npm version it kept).
  const commitWarnings: ImportWarning[] = []

  // Cancellation gate: past this point the commit is atomic and runs to the end.
  signal?.throwIfAborted()

  await adapter.commit((tx) => {
    // Merge reusable conditions first so rule contextStyles keys resolve.
    if ((rewrittenPlan.conditions ?? []).length > 0) {
      tx.addConditions(rewrittenPlan.conditions)
    }
    // Colour tokens before style rules so any framework `--<slug>` they emit
    // is available to everything that follows.
    commitColorTokens(tx, rewrittenPlan, tokenConflictByKey, results)
    commitFonts(tx, rewrittenPlan, installedGoogleFonts, results)
    // Font tokens after fonts so tokens can bind to a matching imported
    // family id when the source stack names one.
    commitFontTokens(tx, rewrittenPlan, tokenConflictByKey, results)
    // Style rules before pages so pages that auto-create class links can
    // reference newly-imported rules.
    commitStyleRules(tx, rewrittenPlan, ruleConflictsByName, results)
    commitPages(tx, linkedPages, pageConflictsBySource, pageIdBySource, results)
    commitPageScopedFiles(tx, withSourceHashes(rewrittenPlan, plan), pageIdBySource, results, commitWarnings)
  })

  // Build asset result — only include the ones that actually uploaded.
  // The user-facing "K assets imported" count needs to match reality; if
  // we listed failed uploads here they'd inflate the count and confuse the
  // Done step.
  const resultAssets: ImportResult['assets'] = plan.assets
    .filter((a) => rewriteMap[a.sourcePath] !== undefined)
    .map((a) => ({
      sourcePath: a.sourcePath,
      mediaUrl: rewriteMap[a.sourcePath]!,
    }))

  return {
    ...results,
    assets: resultAssets,
    conflicts: plan.conflicts,
    // Carry forward the plan-level warnings (CSS parser / asset planner /
    // missing stylesheet …) AND surface any per-asset upload failures from
    // Step A above. The wizard's Done step renders this list verbatim.
    warnings: [...plan.warnings, ...uploadWarnings, ...fontInstallWarnings, ...commitWarnings],
  }
}

type CommitResults = Pick<
  ImportResult,
  'pages' | 'styleRules' | 'fonts' | 'colors' | 'fontTokens' | 'scripts' | 'stylesheets'
>

// ---------------------------------------------------------------------------
// Step A — asset uploads
// ---------------------------------------------------------------------------

/**
 * Upload sequentially to avoid saturating the server — sequential uploads
 * also give clearer progress. A single rejected file (unsupported MIME,
 * oversized payload, network blip) is recorded as an `asset-upload-failed`
 * warning and the rest continue; pages and rules that referenced a failed
 * asset keep their original FileMap reference, so the publisher emits the
 * unrewritten path and the user can re-upload manually.
 */
async function uploadPlanAssets(
  plan: ImportPlan,
  adapter: SiteImportAdapter,
  signal?: AbortSignal,
): Promise<{ rewriteMap: Record<string, string>; warnings: ImportWarning[] }> {
  const rewriteMap: Record<string, string> = {}
  const warnings: ImportWarning[] = []
  // A file the library already holds (a media conflict left at `skip`) is not
  // uploaded again: its references point at the existing asset.
  const reusedUrlBySource = new Map(
    plan.conflicts.media
      .filter((c) => c.defaultResolution.action === 'skip')
      .map((c) => [c.sourcePath, c.existingUrl]),
  )
  for (const asset of plan.assets) {
    const reusedUrl = reusedUrlBySource.get(asset.sourcePath)
    if (reusedUrl !== undefined) {
      rewriteMap[asset.sourcePath] = reusedUrl
      continue
    }
    signal?.throwIfAborted()
    try {
      const uploaded = await adapter.uploadAsset({
        path: asset.sourcePath,
        bytes: asset.bytes,
        mimeType: asset.mimeType,
        ...(asset.altText !== undefined ? { altText: asset.altText } : {}),
        signal,
      })
      rewriteMap[asset.sourcePath] = uploaded.url
      warnings.push(...uploaded.warnings)
    } catch (err) {
      // Cancellation ends the run — it must never degrade into a warning.
      if (isAbortError(err)) throw err
      const reason = err instanceof Error ? err.message : 'Unknown upload error'
      warnings.push({
        kind: 'asset-upload-failed',
        message: `Failed to upload ${asset.sourcePath} (${asset.mimeType}): ${reason}`,
        path: asset.sourcePath,
      })
    }
  }
  return { rewriteMap, warnings }
}

async function installPlanGoogleFonts(
  plan: ImportPlan,
  adapter: SiteImportAdapter,
  signal?: AbortSignal,
): Promise<{ installedGoogleFonts: FontEntry[]; warnings: ImportWarning[] }> {
  const installedGoogleFonts: FontEntry[] = []
  const warnings: ImportWarning[] = []
  for (const font of plan.googleFonts) {
    signal?.throwIfAborted()
    try {
      // Only the request goes to the installer; provenance is planning-only.
      const { family, variants, subsets } = font
      installedGoogleFonts.push(await adapter.installGoogleFont({ family, variants, subsets }))
    } catch (err) {
      if (isAbortError(err)) throw err
      const reason = err instanceof Error ? err.message : 'Unknown font install error'
      warnings.push({
        kind: 'font-install-failed',
        message: `Failed to install Google font ${font.family}: ${reason}`,
        path: font.family,
      })
    }
  }
  return { installedGoogleFonts, warnings }
}

// ---------------------------------------------------------------------------
// Step C — commit helpers (each owns one entity kind)
// ---------------------------------------------------------------------------

/**
 * Pre-mint a stable page id for every page we're about to commit, keyed by
 * its source FileMap path. Overwritten pages reuse the existing id; added
 * pages get a fresh one. This lets `rewriteInternalLinks` turn intra-site
 * `<a href="club.html">` links into `cms:page:<id>` references BEFORE the
 * pages are committed, so they survive future slug renames. The same id is
 * then passed to `tx.addPage` so the ref resolves to the real page.
 */
function mintPageIds(
  plan: ImportPlan,
  pageConflictsBySource: Map<string, PageConflict>,
): Map<string, string> {
  const pageIdBySource = new Map<string, string>()
  for (const page of plan.pages) {
    const conflict = pageConflictsBySource.get(page.source)
    const resolution = conflict?.defaultResolution
    if (resolution?.action === 'skip') continue
    // Only reuse the existing id when there is a real page to overwrite.
    // Intra-batch slug collisions carry an empty `existingPageId` (no existing
    // page yet) — "overwrite" there has no target, so we add a fresh page.
    const id =
      resolution?.action === 'overwrite' && conflict?.existingPageId
        ? conflict.existingPageId
        : nanoid()
    pageIdBySource.set(page.source, id)
  }
  return pageIdBySource
}

/**
 * Partition by conflict resolution — `overwrite` replaces the existing
 * token's value by id; the rest are added (renamed tokens already carry
 * their unique slug).
 */
function commitColorTokens(
  tx: SiteImportTransaction,
  plan: ImportPlan,
  tokenConflictByKey: Map<string, TokenConflict>,
  results: CommitResults,
): void {
  if ((plan.colors ?? []).length === 0) return
  const adds: ImportColorToken[] = []
  const overwrites: { existingTokenId: string; value: string }[] = []
  for (const token of plan.colors) {
    const conflict = tokenConflictByKey.get(`color:${token.slug}`)
    if (conflict?.defaultResolution.action === 'overwrite') {
      overwrites.push({ existingTokenId: conflict.existingTokenId, value: token.value })
    } else {
      adds.push(token)
    }
  }
  if (adds.length > 0) results.colors.push(...tx.addColorTokens(adds))
  if (overwrites.length > 0) results.colors.push(...tx.overwriteColorTokens(overwrites))
}

function commitFontTokens(
  tx: SiteImportTransaction,
  plan: ImportPlan,
  tokenConflictByKey: Map<string, TokenConflict>,
  results: CommitResults,
): void {
  if ((plan.fontTokens ?? []).length === 0) return
  const adds: ImportFontToken[] = []
  const overwrites: { existingTokenId: string; token: ImportFontToken }[] = []
  for (const token of plan.fontTokens) {
    const conflict = tokenConflictByKey.get(`font:${token.variable}`)
    if (conflict?.defaultResolution.action === 'overwrite') {
      overwrites.push({ existingTokenId: conflict.existingTokenId, token })
    } else {
      adds.push(token)
    }
  }
  if (adds.length > 0) results.fontTokens.push(...tx.addFontTokens(adds))
  if (overwrites.length > 0) results.fontTokens.push(...tx.overwriteFontTokens(overwrites))
}

/**
 * Custom fonts: only commit files whose src actually became a media URL
 * (a failed upload leaves a FileMap key). A family with no usable files is
 * dropped rather than producing a broken @font-face.
 */
function commitFonts(
  tx: SiteImportTransaction,
  plan: ImportPlan,
  installedGoogleFonts: FontEntry[],
  results: CommitResults,
): void {
  const commitableFonts = plan.fonts
    .map((font) => ({
      ...font,
      files: font.files.filter((f) => isMediaUrl(f.src)),
    }))
    .filter((font) => font.files.length > 0)
  if (commitableFonts.length > 0) {
    results.fonts.push(...tx.addFonts(commitableFonts))
  }
  if (installedGoogleFonts.length > 0) {
    results.fonts.push(...tx.addInstalledFonts(installedGoogleFonts))
  }
}

function commitStyleRules(
  tx: SiteImportTransaction,
  plan: ImportPlan,
  ruleConflictsByName: Map<string, RuleConflict>,
  results: CommitResults,
): void {
  for (const rule of plan.styleRules) {
    const conflict = rule.kind === 'class'
      ? ruleConflictsByName.get(rule.name)
      : undefined
    const resolution = conflict?.defaultResolution

    if (resolution?.action === 'skip') continue

    let id: string
    if (resolution?.action === 'overwrite' && conflict?.existingRuleId) {
      tx.overwriteStyleRule(conflict.existingRuleId, rule)
      id = conflict.existingRuleId
    } else {
      // Ambient rules never reach the conflict step; a re-imported one is
      // recognised by its origin inside `putStyleRule` and replaced in place.
      id = tx.putStyleRule(rule)
    }

    results.styleRules.push({ id, selector: rule.selector, kind: rule.kind })
  }
}

function commitPages(
  tx: SiteImportTransaction,
  linkedPages: ImportPlan['pages'],
  pageConflictsBySource: Map<string, PageConflict>,
  pageIdBySource: Map<string, string>,
  results: CommitResults,
): void {
  for (const page of linkedPages) {
    const conflict = pageConflictsBySource.get(page.source)
    const resolution = conflict?.defaultResolution

    if (resolution?.action === 'skip') continue

    // The pre-minted id this page's links were rewritten against.
    const mintedId = pageIdBySource.get(page.source)

    let id: string
    if (resolution?.action === 'overwrite' && conflict?.existingPageId) {
      tx.overwritePage(conflict.existingPageId, {
        title: page.title,
        slug: page.slug,
        nodeFragment: page.nodeFragment,
        seo: page.seo,
      })
      id = conflict.existingPageId
    } else {
      id = tx.addPage({
        id: mintedId,
        title: page.title,
        slug: resolution?.resolvedSlug ?? page.slug,
        nodeFragment: page.nodeFragment,
        seo: page.seo,
      })
    }

    results.pages.push({ id, title: page.title, slug: page.slug, source: page.source })
  }
}

/**
 * Scripts and kept stylesheets. A file whose path the site already holds
 * (a `FileConflict`) is reused (`skip`) or replaced in place (`overwrite`);
 * either way the pages this import links it from join its scope. Every other
 * file, including a conflict resolved to `auto-rename`, is added as a new file.
 * Last, the import's files are merged into the site's load order
 * (`tx.orderImportedFiles`).
 */
function commitPageScopedFiles(
  tx: SiteImportTransaction,
  plan: ImportPlan,
  pageIdBySource: Map<string, string>,
  results: CommitResults,
  warnings: ImportWarning[],
): void {
  const fileConflictByKey = new Map<string, FileConflict>(
    plan.conflicts.files.map((c) => [`${c.kind}:${c.path}`, c]),
  )
  const commitKind = <T extends ImportScript | ImportStylesheet>(
    kind: FileConflict['kind'],
    items: T[],
    add: (additions: T[]) => { id: string; path: string }[],
  ): { id: string; path: string }[] => {
    // The import's own order: its priorities rank its files against each other.
    const ordered = resolvePageScopes(items, pageIdBySource).toSorted((x, y) => x.priority - y.priority)
    const additions: T[] = []
    const reuses: SiteFileReuse[] = []
    for (const item of ordered) {
      const conflict = fileConflictByKey.get(`${kind}:${item.path}`)
      const action = conflict?.defaultResolution.action
      if (!conflict || (action !== 'skip' && action !== 'overwrite')) {
        additions.push(item)
        continue
      }
      reuses.push({
        existingFileId: conflict.existingFileId,
        pageIds: item.pageIds ?? [],
        ...(action === 'overwrite' ? { replacement: item } : {}),
      })
    }
    const added = additions.length > 0 ? add(additions) : []
    const reused = reuses.length > 0 ? tx.reuseSiteFiles(reuses) : { files: [], warnings: [] }
    warnings.push(...reused.warnings)

    // `add` returns one entry per item, in order.
    const idByItem = new Map<T, string>(additions.flatMap((item, i) => (added[i] ? [[item, added[i].id]] : [])))
    const reusedIds = new Set(reused.files.map((f) => f.id))
    const importOrder = ordered.flatMap((item) => {
      const addedId = idByItem.get(item)
      if (addedId) return [addedId]
      const existingId = fileConflictByKey.get(`${kind}:${item.path}`)?.existingFileId
      return existingId && reusedIds.has(existingId) ? [existingId] : []
    })
    if (importOrder.length > 0) tx.orderImportedFiles(kind, importOrder, added.map((f) => f.id))
    return [...added, ...reused.files]
  }

  results.scripts.push(...commitKind('script', plan.scripts, (items) => tx.addScripts(items)))
  results.stylesheets.push(...commitKind('style', plan.stylesheets, (items) => tx.addStylesheets(items)))
}

type SiteFileReuse = Parameters<SiteImportTransaction['reuseSiteFiles']>[0][number]

/**
 * Stamp each script and stylesheet with the hash of its text as the bundle
 * had it. `rewritten` carries media URLs in kept stylesheets; `original` is
 * the same plan before `applyAssetRewrites`, so a re-import of an unchanged
 * bundle hashes the same whichever URLs its media got.
 */
function withSourceHashes(rewritten: ImportPlan, original: ImportPlan): ImportPlan {
  const originals = new Map<string, ImportScript | ImportStylesheet>([
    ...original.scripts.map((s): [string, ImportScript] => [`script:${s.path}`, s]),
    ...original.stylesheets.map((s): [string, ImportStylesheet] => [`style:${s.path}`, s]),
  ])
  return {
    ...rewritten,
    scripts: rewritten.scripts.map((s) => ({ ...s, sourceHash: importSourceHash(originals.get(`script:${s.path}`) ?? s) })),
    stylesheets: rewritten.stylesheets.map((s) => ({ ...s, sourceHash: importSourceHash(originals.get(`style:${s.path}`) ?? s) })),
  }
}

/**
 * Resolve an item's `pageSources` (HTML FileMap paths) into committed page
 * ids. Items whose every source page was skipped are dropped — a page-scoped
 * asset with no surviving page has nowhere to apply.
 */
function resolvePageScopes<T extends { pageSources: string[]; pageIds?: string[] }>(
  items: T[],
  pageIdBySource: Map<string, string>,
): T[] {
  return items.flatMap((item) => {
    if (item.pageSources.length === 0) return [item]
    const seen = new Set<string>()
    const pageIds: string[] = []
    for (const source of item.pageSources) {
      const pageId = pageIdBySource.get(source)
      if (!pageId || seen.has(pageId)) continue
      seen.add(pageId)
      pageIds.push(pageId)
    }
    if (pageIds.length === 0) return []
    return [{ ...item, pageIds }]
  })
}

/**
 * A font file `src` that was successfully rewritten to a media URL — either a
 * self-hosted `/uploads/` path or an absolute `https://` URL. A leftover FileMap
 * key (e.g. `fonts/Inter.woff2`) is neither, so the file is dropped.
 */
function isMediaUrl(src: string): boolean {
  return src.startsWith('/uploads/') || src.startsWith('https://')
}
