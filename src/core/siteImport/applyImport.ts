/**
 * applyImport — the top-level orchestrator for the Super Import pipeline.
 *
 * Two exported functions:
 *
 * `buildImportPlan(input)` — PURE, synchronous.
 *   Classifies files, parses HTML and CSS, collects assets, normalises URLs,
 *   detects conflicts.  Returns an `ImportPlan` ready for preview in the
 *   Phase 3 wizard or direct commit.
 *
 * `commitImportPlan(plan, adapter)` — ASYNC.
 *   Step A: Upload assets via `adapter.uploadAsset`. Collect `sourcePath → newUrl`.
 *   Step B: Rewrite the plan with `applyAssetRewrites`.
 *   Step C: ONE `adapter.commit` call that adds all pages + style rules.
 *
 * Atomicity note:
 *   Asset uploads (Step A) are additive — if the process aborts mid-upload,
 *   the already-uploaded assets remain in the media library.  They are harmless
 *   (unused orphans) and will be reaped by a future background sweep.  The
 *   store mutation (Step C) is wrapped in a single `adapter.commit` call that
 *   the admin side executes as one Immer history snapshot — Cmd+Z reverts the
 *   entire import in one step.
 */

import type { SiteDocument, ConditionDef } from '@core/page-tree'
import { compareVariants, type FontEntry } from '@core/fonts'
import { cssToStyleRules } from './cssToStyleRules'
import { expandLinkedCssImports } from './cssImports'
import { extractRootColorTokens } from './colorTokens'
import { extractGoogleFontImports, stripGoogleFontImportRules } from './fontImports'
import { extractRootFontTokens } from './fontTokens'
import { classifyFiles } from './classifyFiles'
import { makeHtmlPagePlan } from './htmlPagePlan'
import { buildAssetPlan, type CssFileResult } from './assetPlan'
import { partitionLinkedStylesheets } from './stylesheetPlan'
import { detectCrossSheetClassConflicts, isSharedUtilityClassName } from './classCascades'
import { rewriteInternalLinks } from './linkRewrite'
import { nanoid } from 'nanoid'
import { applyAssetRewrites } from './applyAssetRewrites'
import { detectConflicts } from './conflicts'
import type {
  FileMap,
  ImportPlan,
  ImportResult,
  ImportWarning,
  ImportColorToken,
  ImportFontToken,
  ImportGoogleFont,
  ImportScript,
  PageConflict,
  RuleConflict,
  StylesheetImportMode,
  TokenConflict,
} from './types'
import type { SiteImportAdapter } from './adapter'

// ---------------------------------------------------------------------------
// buildImportPlan
// ---------------------------------------------------------------------------

export interface BuildImportPlanInput {
  fileMap: FileMap
  currentSite: SiteDocument
  options?: {
    /** Tolerance in px for matching older @media max-width queries by frame width. Default: 10. */
    mediaTolerance?: number
    /**
     * Per-stylesheet import mode, keyed by the top-level linked CSS path
     * (FileMap key). Unlisted paths convert to editable style rules.
     */
    stylesheetModes?: Record<string, StylesheetImportMode>
  }
}

/**
 * Build a fully-analysed `ImportPlan` from a `FileMap` and the current site.
 *
 * This is a pure, synchronous function. Call it before showing the Phase 3
 * wizard so the user can preview what will be imported and resolve conflicts.
 */
export function buildImportPlan({ fileMap, currentSite, options }: BuildImportPlanInput): ImportPlan {
  const mediaTolerance = options?.mediaTolerance ?? 10
  const warnings: ImportWarning[] = []
  const droppedAtRules: string[] = []

  // 1. Classify every file
  const classified = classifyFiles(fileMap)

  // 2. Process each HTML file into a raw PagePlan
  const breakpointHints = currentSite.breakpoints.map((bp) => ({
    id: bp.id,
    width: bp.width,
    mediaQuery: bp.mediaQuery,
  }))

  const rawPagePlans = []
  const allLinkedCssPaths = new Set<string>()
  // Per-page CSS harvested from `<style>` blocks, keyed by pagePlan.source.
  const inlineCssByPage = new Map<string, string>()
  const scriptsByPath = new Map<string, {
    path: string
    content: string
    format: ImportScript['format']
    pageSources: Set<string>
    priority: number
  }>()
  let nextScriptPriority = 100

  for (const f of classified) {
    if (f.role !== 'html') continue
    const htmlSource = decodeUtf8(f.bytes)
    const { pagePlan, warnings: pageWarnings, inlineCss } = makeHtmlPagePlan(f.path, htmlSource, fileMap)
    warnings.push(...pageWarnings)
    rawPagePlans.push(pagePlan)
    if (inlineCss.trim().length > 0) inlineCssByPage.set(pagePlan.source, inlineCss)
    for (const pageScript of pagePlan.scripts) {
      const scriptPath = pageScript.path
      const existing = scriptsByPath.get(scriptPath)
      if (existing) {
        existing.pageSources.add(pagePlan.source)
        continue
      }

      const content = pageScript.kind === 'inline'
        ? pageScript.content
        : decodeExternalScript(fileMap, pageScript.path)
      if (content === null) continue

      scriptsByPath.set(scriptPath, {
        path: scriptPath,
        content,
        format: pageScript.format,
        pageSources: new Set([pagePlan.source]),
        priority: nextScriptPriority,
      })
      nextScriptPriority += 1
    }
  }
  const scripts: ImportScript[] = [...scriptsByPath.values()].map((script) => ({
    ...script,
    pageSources: [...script.pageSources],
  }))

  const googleFontsByFamily = new Map<string, ImportGoogleFont>()

  function collectGoogleFonts(cssSource: string): void {
    for (const font of extractGoogleFontImports(cssSource)) {
      const key = font.family.toLowerCase()
      const existing = googleFontsByFamily.get(key)
      if (!existing) {
        googleFontsByFamily.set(key, font)
        continue
      }
      existing.variants = [...new Set([...existing.variants, ...font.variants])].sort(compareVariants)
      existing.subsets = [...new Set([...existing.subsets, ...font.subsets])]
    }
  }

  // 2b. Catalogue top-level linked stylesheets by import mode; flatten the
  //     kept ones (`mode: 'file'`) verbatim. See stylesheetPlan.ts.
  const partition = partitionLinkedStylesheets(
    rawPagePlans,
    fileMap,
    options?.stylesheetModes ?? {},
    collectGoogleFonts,
  )
  warnings.push(...partition.warnings)
  droppedAtRules.push(...partition.droppedAtRules)
  const { linkedStylesheets, keptStylesheetPaths, rawStylesheetSources } = partition

  const cssSourcesByPath = new Map<string, string>()
  const orderedCssPaths: string[] = []
  allLinkedCssPaths.clear()
  for (const cssPath of partition.usedCssPaths) allLinkedCssPaths.add(cssPath)
  for (const plan of rawPagePlans) {
    // Kept stylesheets bypass conversion entirely — only the converted sheets
    // join the page's cascade of parsed rules.
    const convertedTopLevel = plan.linkedCssPaths.filter((cssPath) => !keptStylesheetPaths.has(cssPath))
    const expanded = expandLinkedCssImports(convertedTopLevel, fileMap)
    warnings.push(...expanded.warnings)
    for (const w of expanded.warnings) {
      if (w.kind === 'dropped-at-rule' && w.source) droppedAtRules.push(w.source)
    }
    plan.linkedCssPaths = expanded.cssPaths
    for (const cssPath of expanded.cssPaths) allLinkedCssPaths.add(cssPath)
    for (const source of expanded.sources) {
      if (cssSourcesByPath.has(source.cssPath)) continue
      cssSourcesByPath.set(source.cssPath, source.cssSource)
      orderedCssPaths.push(source.cssPath)
    }
  }

  // 3. Parse CSS files linked from ≥1 page; record unused CSS
  const unusedCss: string[] = []
  const cssFileResults: CssFileResult[] = []
  // Reusable conditions discovered across all CSS files, deduped by id.
  const conditionsById = new Map<string, ConditionDef>()
  // Colour tokens pulled from root-scope rules, deduped by slug (first wins).
  const colorsBySlug = new Map<string, ImportColorToken>()
  // Font tokens pulled from root-scope rules, deduped by normalized variable.
  const fontTokensByVariable = new Map<string, ImportFontToken>()

  for (const f of classified) {
    if (f.role !== 'css') continue
    if (!allLinkedCssPaths.has(f.path)) {
      unusedCss.push(f.path)
    }
  }

  for (const cssPath of orderedCssPaths) {
    const cssSource = cssSourcesByPath.get(cssPath)
    if (!cssSource) continue
    collectGoogleFonts(cssSource)
    const cssForStyleRules = stripGoogleFontImportRules(cssSource)
    const { rules, warnings: cssWarnings, assetRefs, conditions: cssConditions, fontFaces } = cssToStyleRules(cssForStyleRules, {
      breakpoints: breakpointHints,
      mediaTolerance,
    })
    warnings.push(...cssWarnings)
    for (const def of cssConditions) {
      if (!conditionsById.has(def.id)) conditionsById.set(def.id, def)
    }

    // Collect dropped at-rules from CSS warnings for the summary
    for (const w of cssWarnings) {
      if (w.kind === 'dropped-at-rule' && w.source) droppedAtRules.push(w.source)
    }

    // Pull colour-valued root custom properties out of the rules so they become
    // framework colour tokens instead of a leftover `:root` rule (which would
    // double-emit each `--<slug>` alongside the framework's own output).
    const { rules: rulesAfterColors, colorTokens } = extractRootColorTokens(rules)
    for (const token of colorTokens) {
      if (!colorsBySlug.has(token.slug)) colorsBySlug.set(token.slug, token)
    }
    const { rules: rulesAfterFontTokens, fontTokens } = extractRootFontTokens(rulesAfterColors)
    for (const token of fontTokens) {
      if (!fontTokensByVariable.has(token.variable)) fontTokensByVariable.set(token.variable, token)
    }

    cssFileResults.push({ cssPath, rules: rulesAfterFontTokens, assetRefs, fontFaces })
  }

  // 4a-inline. Fold each page's `<style>` CSS in as a synthetic per-page source.
  //   The synthetic cssPath `<htmlPath>::inline` keeps `url(...)` resolution
  //   relative to the HTML file's directory (dirname() drops the suffix) and is
  //   appended LAST to the page's linked paths so an inline `<style>` wins the
  //   cascade over external sheets for a shared class name. Routed through the
  //   exact same parse → colour-token → scope → asset → conflict pipeline.
  for (const plan of rawPagePlans) {
    const inlineCss = inlineCssByPage.get(plan.source)
    if (!inlineCss) continue
    const syntheticPath = `${plan.source}::inline`
    collectGoogleFonts(inlineCss)
    const cssForStyleRules = stripGoogleFontImportRules(inlineCss)
    const { rules, warnings: cssWarnings, assetRefs, conditions: cssConditions, fontFaces } =
      cssToStyleRules(cssForStyleRules, { breakpoints: breakpointHints, mediaTolerance })
    warnings.push(...cssWarnings)
    for (const def of cssConditions) {
      if (!conditionsById.has(def.id)) conditionsById.set(def.id, def)
    }
    for (const w of cssWarnings) {
      if (w.kind === 'dropped-at-rule' && w.source) droppedAtRules.push(w.source)
    }
    const { rules: rulesAfterColors, colorTokens } = extractRootColorTokens(rules)
    for (const token of colorTokens) {
      if (!colorsBySlug.has(token.slug)) colorsBySlug.set(token.slug, token)
    }
    const { rules: rulesAfterFontTokens, fontTokens } = extractRootFontTokens(rulesAfterColors)
    for (const token of fontTokens) {
      if (!fontTokensByVariable.has(token.variable)) fontTokensByVariable.set(token.variable, token)
    }
    cssFileResults.push({ cssPath: syntheticPath, rules: rulesAfterFontTokens, assetRefs, fontFaces })
    plan.linkedCssPaths = [...plan.linkedCssPaths, syntheticPath]
  }

  // 4b. Detect divergent cross-sheet class definitions among the CONVERTED
  //     stylesheets. Converted sheets merge CSS-natively into the one global
  //     cascade; when two page cascades define the same class differently,
  //     that becomes an explicit conflict (default: rename with a suffix) for
  //     the wizard's Conflicts step — applied by
  //     `applyCrossSheetClassResolutions`, never silently here.
  const existingClassNames = Object.values(currentSite.styleRules)
    .filter((rule) => rule.kind === 'class')
    .map((rule) => rule.name)
  const crossSheetClasses = detectCrossSheetClassConflicts(
    rawPagePlans,
    cssFileResults,
    existingClassNames,
  )
  const publishableCssFileResults = preserveGloballyMatchedClassRules(
    rawPagePlans,
    cssFileResults,
  )

  // 5. Build asset plan — normalises URLs in node props, CSS values, and kept
  //    stylesheet text; resolves @font-face blocks; collects assets to upload
  const { normalizedPagePlans, normalizedStyleRules, styleRuleSources, stylesheets, fonts, assets, warnings: assetWarnings } =
    buildAssetPlan(rawPagePlans, publishableCssFileResults, fileMap, rawStylesheetSources)
  warnings.push(...assetWarnings)

  // 6. Detect conflicts against the current site — pages, class rules, and
  //    design tokens (colour + font) all flow through one resolution model.
  const conflicts = detectConflicts(
    currentSite,
    normalizedPagePlans,
    normalizedStyleRules,
    [...colorsBySlug.values()],
    [...fontTokensByVariable.values()],
  )

  return {
    pages: normalizedPagePlans,
    styleRules: normalizedStyleRules,
    styleRuleSources,
    fonts,
    googleFonts: [...googleFontsByFamily.values()],
    conditions: [...conditionsById.values()],
    assets,
    colors: [...colorsBySlug.values()],
    fontTokens: [...fontTokensByVariable.values()],
    scripts,
    linkedStylesheets,
    stylesheets,
    conflicts: { ...conflicts, crossSheetClasses },
    warnings,
    droppedAtRules,
    unusedCss,
  }
}

// ---------------------------------------------------------------------------
// commitImportPlan
// ---------------------------------------------------------------------------

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
 * Apply a `plan` to the site via the adapter, returning an `ImportResult`
 * describing what was actually committed.
 *
 * The plan is assumed to already have conflict resolutions applied (via
 * `applyConflictResolutions`) before being passed here.  The raw conflicts
 * stored on the plan are forwarded unchanged to the ImportResult for the
 * Phase 3 Done step.
 *
 * Atomicity guarantee:
 *   - Step A (asset uploads): network, cannot be rolled back. Per-asset
 *     failures (e.g. an unsupported file type, oversized file, server-side
 *     reject) are caught and recorded as `asset-upload-failed` warnings.
 *     The remaining assets continue to upload — one bad file no longer
 *     aborts the whole import. Orphaned uploads from a partial failure
 *     are left in place; they are harmless and will be swept up by a
 *     future background job.
 *   - Step C (store mutation): a single `adapter.commit` call — the adapter
 *     executes it as one Immer history snapshot; Cmd+Z reverts everything.
 *
 * @throws When the store mutation itself fails (Step C). Per-asset failures
 *         in Step A do NOT throw — they are reported in the result's
 *         warnings list.
 */
export async function commitImportPlan(
  plan: ImportPlan,
  adapter: SiteImportAdapter,
): Promise<ImportResult> {
  // ── Step A: Upload all assets ──────────────────────────────────────────────
  //
  // Upload sequentially to avoid saturating the server. The spec does not
  // require parallelism here and sequential uploads give clearer progress.
  //
  // Per-asset try/catch: a single rejected file (unsupported MIME from the
  // server's allowlist, oversized payload, network blip) used to abort the
  // entire commit and stranded every following asset. We now record the
  // failure as a warning and continue — pages and rules that referenced
  // a failed asset keep their original `url('FileMap-key')` reference, so
  // the publisher emits the unrewritten path. The user sees the warning in
  // the Done step and can re-upload manually.
  const rewriteMap: Record<string, string> = {}
  const uploadWarnings: import('./types').ImportWarning[] = []
  const fontInstallWarnings: import('./types').ImportWarning[] = []

  for (const asset of plan.assets) {
    try {
      const newUrl = await adapter.uploadAsset({
        path: asset.sourcePath,
        bytes: asset.bytes,
        mimeType: asset.mimeType,
      })
      rewriteMap[asset.sourcePath] = newUrl
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown upload error'
      uploadWarnings.push({
        kind: 'asset-upload-failed',
        message: `Failed to upload ${asset.sourcePath} (${asset.mimeType}): ${reason}`,
        path: asset.sourcePath,
      })
    }
  }

  // ── Step B: Rewrite plan URLs ──────────────────────────────────────────────
  const rewrittenPlan = applyAssetRewrites(plan, rewriteMap)

  const installedGoogleFonts: FontEntry[] = []
  for (const font of rewrittenPlan.googleFonts) {
    try {
      installedGoogleFonts.push(await adapter.installGoogleFont(font))
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown font install error'
      fontInstallWarnings.push({
        kind: 'font-install-failed',
        message: `Failed to install Google font ${font.family}: ${reason}`,
        path: font.family,
      })
    }
  }

  // ── Step C: Commit pages + style rules (single atomic transaction) ─────────
  const resultPages: ImportResult['pages'] = []
  const resultRules: ImportResult['styleRules'] = []
  const resultFonts: ImportResult['fonts'] = []
  const resultColors: ImportResult['colors'] = []
  const resultFontTokens: ImportResult['fontTokens'] = []
  const resultScripts: ImportResult['scripts'] = []
  const resultStylesheets: ImportResult['stylesheets'] = []

  // Build conflict resolution lookup maps (source → resolution)
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

  // Pre-mint a stable page id for every page we're about to commit, keyed by
  // its source FileMap path. Overwritten pages reuse the existing id; added
  // pages get a fresh one. This lets `rewriteInternalLinks` turn intra-site
  // `<a href="club.html">` links into `cms:page:<id>` references BEFORE the
  // pages are committed, so they survive future slug renames. The same id is
  // then passed to `tx.addPage` so the ref resolves to the real page.
  const pageIdBySource = new Map<string, string>()
  for (const page of rewrittenPlan.pages) {
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
  const linkedPages = rewriteInternalLinks(rewrittenPlan.pages, pageIdBySource)

  await adapter.commit((tx) => {
    // Merge reusable conditions first so rule contextStyles keys resolve.
    if ((rewrittenPlan.conditions ?? []).length > 0) {
      tx.addConditions(rewrittenPlan.conditions)
    }

    // Colour tokens: register before style rules so any framework `--<slug>`
    // they emit is available to everything that follows. Partition by conflict
    // resolution — `overwrite` replaces the existing token's value by id; the
    // rest are added (renamed tokens already carry their unique slug).
    if ((rewrittenPlan.colors ?? []).length > 0) {
      const colorAdds: ImportColorToken[] = []
      const colorOverwrites: { existingTokenId: string; value: string }[] = []
      for (const token of rewrittenPlan.colors) {
        const conflict = tokenConflictByKey.get(`color:${token.slug}`)
        if (conflict?.defaultResolution.action === 'overwrite') {
          colorOverwrites.push({ existingTokenId: conflict.existingTokenId, value: token.value })
        } else {
          colorAdds.push(token)
        }
      }
      if (colorAdds.length > 0) resultColors.push(...tx.addColorTokens(colorAdds))
      if (colorOverwrites.length > 0) resultColors.push(...tx.overwriteColorTokens(colorOverwrites))
    }

    // Custom fonts: only commit files whose src actually became a media URL
    // (a failed upload leaves a FileMap key). A family with no usable files is
    // dropped rather than producing a broken @font-face.
    const commitableFonts = rewrittenPlan.fonts
      .map((font) => ({
        ...font,
        files: font.files.filter((f) => isMediaUrl(f.src)),
      }))
      .filter((font) => font.files.length > 0)
    if (commitableFonts.length > 0) {
      resultFonts.push(...tx.addFonts(commitableFonts))
    }
    if (installedGoogleFonts.length > 0) {
      resultFonts.push(...tx.addInstalledFonts(installedGoogleFonts))
    }

    // Font tokens: register after fonts so tokens can bind to a matching
    // imported family id when the source stack names one. Same overwrite/add
    // partition as colour tokens.
    if ((rewrittenPlan.fontTokens ?? []).length > 0) {
      const fontAdds: ImportFontToken[] = []
      const fontOverwrites: { existingTokenId: string; token: ImportFontToken }[] = []
      for (const token of rewrittenPlan.fontTokens) {
        const conflict = tokenConflictByKey.get(`font:${token.variable}`)
        if (conflict?.defaultResolution.action === 'overwrite') {
          fontOverwrites.push({ existingTokenId: conflict.existingTokenId, token })
        } else {
          fontAdds.push(token)
        }
      }
      if (fontAdds.length > 0) resultFontTokens.push(...tx.addFontTokens(fontAdds))
      if (fontOverwrites.length > 0) resultFontTokens.push(...tx.overwriteFontTokens(fontOverwrites))
    }

    // Commit style rules first so pages that auto-create class links can
    // reference newly-imported rules.
    for (const rule of rewrittenPlan.styleRules) {
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
        id = tx.addStyleRule(rule)
      }

      resultRules.push({ id, selector: rule.selector, kind: rule.kind })
    }

    // Commit pages (with internal links already rewritten to page refs).
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
        })
        id = conflict.existingPageId
      } else {
        id = tx.addPage({
          id: mintedId,
          title: page.title,
          slug: resolution?.resolvedSlug ?? page.slug,
          nodeFragment: page.nodeFragment,
        })
      }

      resultPages.push({ id, title: page.title, slug: page.slug, source: page.source })
    }

    const scopedScripts = resolvePageScopes(rewrittenPlan.scripts ?? [], pageIdBySource)
    if (scopedScripts.length > 0) {
      resultScripts.push(...tx.addScripts(scopedScripts))
    }

    const scopedStylesheets = resolvePageScopes(rewrittenPlan.stylesheets ?? [], pageIdBySource)
    if (scopedStylesheets.length > 0) {
      resultStylesheets.push(...tx.addStylesheets(scopedStylesheets))
    }
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
    pages: resultPages,
    styleRules: resultRules,
    fonts: resultFonts,
    assets: resultAssets,
    colors: resultColors,
    fontTokens: resultFontTokens,
    scripts: resultScripts,
    stylesheets: resultStylesheets,
    conflicts: plan.conflicts,
    // Carry forward the plan-level warnings (CSS parser / asset planner /
    // missing stylesheet …) AND surface any per-asset upload failures from
    // Step A above. The wizard's Done step renders this list verbatim.
    warnings: [...plan.warnings, ...uploadWarnings, ...fontInstallWarnings],
  }
}

// ---------------------------------------------------------------------------
// Re-export applyConflictResolutions for callers that need to override defaults
// ---------------------------------------------------------------------------

export { applyConflictResolutions } from './conflicts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode UTF-8 bytes to a string. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function decodeExternalScript(fileMap: FileMap, path: string): string | null {
  const file = fileMap.files[path]
  return file ? decodeUtf8(file.bytes) : null
}

function preserveGloballyMatchedClassRules(
  pagePlans: ImportPlan['pages'],
  cssFileResults: CssFileResult[],
): CssFileResult[] {
  // Class-kind rules are tree-shaken by the publisher unless a node owns their
  // class id. Runtime-only classes and shared utility fragments must instead
  // remain ambient selectors: scripts may add the former later, and utilities
  // like `.row` need every source rule even though nodes only link one token.
  const usedClassNames = collectImportedNodeClassNames(pagePlans)
  return cssFileResults.map((file) => {
    let changed = false
    const rules = file.rules.map((rule) => {
      if (rule.kind !== 'class') return rule
      if (isSharedUtilityClassName(rule.name) || !usedClassNames.has(rule.name)) {
        changed = true
        return {
          ...rule,
          kind: 'ambient' as const,
          name: rule.selector,
        }
      }
      return rule
    })
    return changed ? { ...file, rules } : file
  })
}

function collectImportedNodeClassNames(pagePlans: ImportPlan['pages']): Set<string> {
  const names = new Set<string>()
  for (const page of pagePlans) {
    for (const className of page.nodeFragment.body?.classIds ?? []) names.add(className)
    for (const node of Object.values(page.nodeFragment.nodes)) {
      for (const className of node.classIds ?? []) names.add(className)
    }
  }
  return names
}

/**
 * A font file `src` that was successfully rewritten to a media URL — either a
 * self-hosted `/uploads/` path or an absolute `https://` URL. A leftover FileMap
 * key (e.g. `fonts/Inter.woff2`) is neither, so the file is dropped.
 */
function isMediaUrl(src: string): boolean {
  return src.startsWith('/uploads/') || src.startsWith('https://')
}
