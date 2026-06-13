/**
 * conflicts — detect and resolve slug / class-name collisions.
 *
 * Page conflicts:
 *   The desired slug (from htmlPagePlan) collides with an existing page slug
 *   in the site. Default resolution: auto-rename (`about` → `about-2`,
 *   `-3`, `-4`, ... until a free slot is found).
 *
 * Rule conflicts:
 *   Only `kind:'class'` rules can conflict because class names must be unique
 *   across the global registry. Ambient rules never conflict — multiple rules
 *   with identical selectors are allowed and resolved by `order`.
 *
 * Applying resolutions:
 *   `applyConflictResolutions(plan, resolutions)` returns a new ImportPlan
 *   with resolved slugs / names applied. Callers can override individual
 *   items by passing a partial array of resolutions.
 */

import type {
  ImportPlan,
  PageConflict,
  RuleConflict,
  TokenConflict,
  CrossSheetClassConflict,
  ConflictResolution,
  PagePlan,
  NewStyleRule,
  ImportColorToken,
  ImportFontToken,
} from './types'
import type { SiteDocument, PageNode } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import { normalizeFrameworkColorSlug } from '@core/framework'
import { normalizeFontTokenVariable } from '@core/fonts'
import { applyCrossSheetClassResolutions, normalizeBindableClassRules } from './classCascades'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface ConflictDetectionResult {
  pages: PageConflict[]
  rules: RuleConflict[]
  tokens: TokenConflict[]
}

/**
 * Detect all slug, rule-name, and design-token collisions between an
 * in-progress ImportPlan and the existing site.
 *
 * Does NOT mutate the plan — returns a description of the conflicts with
 * default resolutions pre-computed.
 */
export function detectConflicts(
  currentSite: SiteDocument,
  pagePlans: PagePlan[],
  styleRules: NewStyleRule[],
  colorTokens: ImportColorToken[] = [],
  fontTokens: ImportFontToken[] = [],
): ConflictDetectionResult {
  const pageConflicts = detectPageConflicts(currentSite, pagePlans)
  const ruleConflicts = detectRuleConflicts(currentSite, styleRules)
  const tokenConflicts = detectTokenConflicts(currentSite, colorTokens, fontTokens)
  return { pages: pageConflicts, rules: ruleConflicts, tokens: tokenConflicts }
}

// ---------------------------------------------------------------------------
// Page conflict detection
// ---------------------------------------------------------------------------

function detectPageConflicts(
  site: SiteDocument,
  pagePlans: PagePlan[],
): PageConflict[] {
  const conflicts: PageConflict[] = []

  // Build slug → id map for existing pages
  const existingSlugs = new Map<string, string>()
  for (const page of site.pages) {
    existingSlugs.set(page.slug, page.id)
  }

  // Track ALL claimed slugs — existing pages AND earlier items in the same
  // import batch. This catches both site-vs-import AND intra-batch collisions
  // (two HTML files that would resolve to the same slug).
  //
  // Values: real page id for existing-page claims, 'import:<source>' for
  // intra-batch claims. The existingPageId on the conflict reflects this:
  // empty string for intra-batch collisions (no real page yet).
  const claimedSlugs = new Map<string, string>(existingSlugs)

  for (const plan of pagePlans) {
    const desiredSlug = plan.slug
    const claimedBy = claimedSlugs.get(desiredSlug)

    if (claimedBy !== undefined) {
      const resolvedSlug = nextAvailableSlug(desiredSlug, claimedSlugs)
      // existingPageId is the real site-page id if the collision is with an
      // existing page; empty string for intra-batch collisions.
      const existingPageId = existingSlugs.get(desiredSlug) ?? ''
      conflicts.push({
        source: plan.source,
        desiredSlug,
        existingPageId,
        defaultResolution: {
          action: 'auto-rename',
          resolvedSlug,
        },
      })
      claimedSlugs.set(resolvedSlug, `import:${plan.source}`)
    } else {
      // No conflict — claim the slug for subsequent items in the same batch.
      claimedSlugs.set(desiredSlug, `import:${plan.source}`)
    }
  }

  return conflicts
}

// ---------------------------------------------------------------------------
// Rule conflict detection
// ---------------------------------------------------------------------------

function detectRuleConflicts(
  site: SiteDocument,
  styleRules: NewStyleRule[],
): RuleConflict[] {
  const conflicts: RuleConflict[] = []

  // Only kind:'class' rules have unique-name constraints
  const existingClassNames = new Map<string, string>()
  for (const rule of Object.values(site.styleRules)) {
    if (rule.kind === 'class') existingClassNames.set(rule.name, rule.id)
  }

  // Track names claimed by earlier items in the import batch
  const claimedNames = new Map<string, string>(existingClassNames)
  // A class may arrive as several cascade fragments with one name — they
  // rename together, so they share ONE conflict row.
  const conflictedNames = new Set<string>()

  for (const rule of styleRules) {
    if (rule.kind !== 'class') continue // ambient rules never conflict

    const desiredName = rule.name
    if (conflictedNames.has(desiredName)) continue
    const existingId = existingClassNames.get(desiredName)

    if (existingId) {
      conflictedNames.add(desiredName)
      const resolvedName = nextAvailableName(desiredName, claimedNames)
      conflicts.push({
        source: '', // CSS file path is not tracked per-rule in NewStyleRule
        desiredName,
        existingRuleId: existingId,
        defaultResolution: {
          action: 'auto-rename',
          resolvedName,
        },
      })
      claimedNames.set(resolvedName, `import:${desiredName}`)
    } else {
      claimedNames.set(desiredName, `import:${desiredName}`)
    }
  }

  return conflicts
}

// ---------------------------------------------------------------------------
// Design-token conflict detection
// ---------------------------------------------------------------------------

/**
 * Detect colour-token and font-token collisions against the existing site.
 *
 * A colour token conflicts when its `--<slug>` (normalised) already exists in
 * `site.settings.framework.colors.tokens`; a font token conflicts when its
 * `--font-*` variable (normalised) already exists in `site.settings.fonts.tokens`.
 * Imported tokens are deduped per kind upstream, so only site-vs-import
 * collisions are possible here (no intra-batch case).
 */
function detectTokenConflicts(
  site: SiteDocument,
  colorTokens: ImportColorToken[],
  fontTokens: ImportFontToken[],
): TokenConflict[] {
  const conflicts: TokenConflict[] = []

  // ── Colour tokens — keyed by normalised slug ──────────────────────────────
  const existingColorIds = new Map<string, string>()
  for (const token of site.settings.framework?.colors?.tokens ?? []) {
    existingColorIds.set(normalizeFrameworkColorSlug(token.slug), token.id)
  }
  const claimedColors = new Set(existingColorIds.keys())
  for (const token of colorTokens) {
    const existingId = existingColorIds.get(normalizeFrameworkColorSlug(token.slug))
    if (!existingId) continue
    const resolved = nextAvailableVariable(token.slug, claimedColors, normalizeFrameworkColorSlug)
    conflicts.push({
      kind: 'color',
      desiredVariable: token.slug,
      existingTokenId: existingId,
      defaultResolution: { action: 'auto-rename', resolvedVariable: resolved },
    })
    claimedColors.add(normalizeFrameworkColorSlug(resolved))
  }

  // ── Font tokens — keyed by normalised variable ────────────────────────────
  const existingFontIds = new Map<string, string>()
  for (const token of site.settings.fonts?.tokens ?? []) {
    existingFontIds.set(normalizeFontTokenVariable(token.variable), token.id)
  }
  const claimedFonts = new Set(existingFontIds.keys())
  for (const token of fontTokens) {
    const existingId = existingFontIds.get(normalizeFontTokenVariable(token.variable))
    if (!existingId) continue
    const resolved = nextAvailableVariable(token.variable, claimedFonts, normalizeFontTokenVariable)
    conflicts.push({
      kind: 'font',
      desiredVariable: token.variable,
      existingTokenId: existingId,
      defaultResolution: { action: 'auto-rename', resolvedVariable: resolved },
    })
    claimedFonts.add(normalizeFontTokenVariable(resolved))
  }

  return conflicts
}

// ---------------------------------------------------------------------------
// Auto-rename helpers
// ---------------------------------------------------------------------------

/**
 * Find the first available slug by appending `-2`, `-3`, `-4`, ... until
 * none of the claimed slugs match.
 */
function nextAvailableSlug(
  baseSlug: string,
  claimedSlugs: Map<string, string>,
): string {
  let suffix = 2
  while (true) {
    const candidate = `${baseSlug}-${suffix}`
    if (!claimedSlugs.has(candidate)) return candidate
    suffix++
  }
}

/**
 * Find the first available class name by appending `-2`, `-3`, `-4`, ...
 */
function nextAvailableName(
  baseName: string,
  claimedNames: Map<string, string>,
): string {
  let suffix = 2
  while (true) {
    const candidate = `${baseName}-${suffix}`
    if (!claimedNames.has(candidate)) return candidate
    suffix++
  }
}

/**
 * Find the first available token variable by appending `-2`, `-3`, ... to the
 * raw (reference-matching) name, testing each candidate's NORMALISED form
 * against the claimed set. Returns the raw candidate so the rewriter can match
 * `var(--<raw>)` references in the imported CSS.
 */
function nextAvailableVariable(
  base: string,
  claimedNormalized: Set<string>,
  normalize: (value: string) => string,
): string {
  let suffix = 2
  while (true) {
    const candidate = `${base}-${suffix}`
    if (!claimedNormalized.has(normalize(candidate))) return candidate
    suffix++
  }
}

// ---------------------------------------------------------------------------
// Resolution application
// ---------------------------------------------------------------------------

/**
 * Apply a set of conflict resolutions to an ImportPlan, returning a new plan
 * with resolved slugs, rule names, and token variables substituted in.
 *
 * Pass the full `plan.conflicts.pages` / `.rules` / `.tokens` arrays as
 * resolutions to apply defaults, or modified copies to apply user overrides.
 *
 * Token renames also rewrite every `var(--old)` reference in the imported
 * style rules and node inline styles to the new name, so the imported design
 * keeps resolving to its own token rather than silently binding to the
 * pre-existing same-named one. `skip` drops the imported token (references keep
 * the old name and bind to the existing token); `overwrite` keeps the token in
 * place (commit replaces the existing token's value).
 */
export function applyConflictResolutions(
  plan: ImportPlan,
  pageResolutions: PageConflict[],
  ruleResolutions: RuleConflict[],
  tokenResolutions: TokenConflict[] = [],
  crossSheetResolutions: CrossSheetClassConflict[] = [],
): ImportPlan {
  // Cross-sheet class resolutions apply FIRST: a definition renamed to
  // `btn-2` here no longer participates in a site-vs-import conflict on
  // `btn`, while the kept definition still does.
  plan = applyCrossSheetClassResolutions(plan, crossSheetResolutions)

  const pageRes = new Map(pageResolutions.map((r) => [r.source, r.defaultResolution]))
  const ruleRes = new Map(ruleResolutions.map((r) => [r.desiredName, r.defaultResolution]))
  const classRenames = buildClassRenameMap(ruleResolutions)
  const tokenMaps = buildTokenRenameMaps(tokenResolutions)

  const pages = resolvePagePlans(plan.pages, pageRes, classRenames, tokenMaps.varRenames)
  const styleRules = resolveStyleRules(plan.styleRules, ruleRes, classRenames, tokenMaps.varRenames)
  const { colors, fontTokens } = resolveTokenLists(plan.colors, plan.fontTokens, tokenMaps)

  // The registry requires unique class names: after all renames have landed,
  // demote every repeated class-kind rule (cascade fragments of one name) to
  // an ambient rule with the same selector — its declarations keep their
  // cascade position; only the first fragment stays bindable.
  return normalizeBindableClassRules({ ...plan, pages, styleRules, colors, fontTokens })
}

/**
 * The `originalName → resolvedName` rename map. Only rename actions move a
 * class to a new name; `skip` keeps the original name (the node intentionally
 * binds to the pre-existing same-named rule).
 */
function buildClassRenameMap(ruleResolutions: RuleConflict[]): Map<string, string> {
  const classRenames = new Map<string, string>()
  for (const r of ruleResolutions) {
    const res = r.defaultResolution
    if (isRename(res) && res.resolvedName && res.resolvedName !== r.desiredName) {
      classRenames.set(r.desiredName, res.resolvedName)
    }
  }
  return classRenames
}

/**
 * Token rename maps — separate per kind for transforming the imported token
 * lists, plus a combined map for rewriting `var(--x)` references (which share
 * one CSS custom-property namespace).
 */
interface TokenResolutionMaps {
  colorRenames: Map<string, string>
  fontRenames: Map<string, string>
  colorSkips: Set<string>
  fontSkips: Set<string>
  varRenames: Map<string, string>
}

function buildTokenRenameMaps(tokenResolutions: TokenConflict[]): TokenResolutionMaps {
  const colorRenames = new Map<string, string>()
  const fontRenames = new Map<string, string>()
  const colorSkips = new Set<string>()
  const fontSkips = new Set<string>()
  for (const r of tokenResolutions) {
    const res = r.defaultResolution
    const renames = r.kind === 'color' ? colorRenames : fontRenames
    if (isRename(res) && res.resolvedVariable && res.resolvedVariable !== r.desiredVariable) {
      renames.set(r.desiredVariable, res.resolvedVariable)
    } else if (res.action === 'skip') {
      ;(r.kind === 'color' ? colorSkips : fontSkips).add(r.desiredVariable)
    }
  }
  const varRenames = new Map<string, string>([...colorRenames, ...fontRenames])
  return { colorRenames, fontRenames, colorSkips, fontSkips, varRenames }
}

/**
 * Apply page resolutions. Imported fragment nodes still carry class *names*
 * in `classIds` (walkAndMap copies `el.classList` verbatim; names become
 * registry ids only at commit). When a rule was renamed we MUST rewrite those
 * names too; when a token was renamed we rewrite `var(--x)` in the node's
 * inline styles. Otherwise the node keeps the original reference and silently
 * binds to a different same-named rule/token at commit.
 */
function resolvePagePlans(
  pages: PagePlan[],
  pageRes: Map<string, PageConflict['defaultResolution']>,
  classRenames: Map<string, string>,
  varRenames: Map<string, string>,
): PagePlan[] {
  return pages.map((page) => {
    const remappedFragment = remapFragment(page.nodeFragment, classRenames, varRenames)

    const res = pageRes.get(page.source)
    if (!res || res.action === 'skip') {
      // No slug change (or skip handled at commit time), but the fragment may
      // still need its class names / var refs remapped.
      return remappedFragment === page.nodeFragment
        ? page
        : { ...page, nodeFragment: remappedFragment }
    }
    const resolvedSlug = res.resolvedSlug ?? page.slug
    return { ...page, slug: resolvedSlug, nodeFragment: remappedFragment }
  })
}

/** Apply rule name resolutions, then rewrite any token var references. */
function resolveStyleRules(
  styleRules: NewStyleRule[],
  ruleRes: Map<string, RuleConflict['defaultResolution']>,
  classRenames: Map<string, string>,
  varRenames: Map<string, string>,
): NewStyleRule[] {
  return styleRules.map((rule) => {
    let next = rule
    if (rule.kind === 'class') {
      const res = ruleRes.get(rule.name)
      // `skip` keeps the original name (binds to the pre-existing rule).
      if (res && res.action !== 'skip') {
        const resolvedName = res.resolvedName ?? rule.name
        // The selector must stay in sync with the name for class-kind rules.
        next = { ...next, name: resolvedName, selector: `.${resolvedName}` }
      }
    } else if (classRenames.size > 0) {
      next = rewriteAmbientRuleClassRefs(rule, classRenames)
    }
    return varRenames.size > 0 ? rewriteRuleVarRefs(next, varRenames) : next
  })
}

/**
 * Transform the imported token lists: drop skipped tokens (existing wins),
 * rename renamed tokens to their unique name. Overwrite tokens stay as-is —
 * commit replaces the existing token's value by id.
 */
function resolveTokenLists(
  colors: ImportPlan['colors'],
  fontTokens: ImportPlan['fontTokens'],
  maps: TokenResolutionMaps,
): { colors: ImportPlan['colors']; fontTokens: ImportPlan['fontTokens'] } {
  return {
    colors: colors
      .filter((token) => !maps.colorSkips.has(token.slug))
      .map((token) => {
        const renamed = maps.colorRenames.get(token.slug)
        return renamed ? { ...token, slug: renamed } : token
      }),
    fontTokens: fontTokens
      .filter((token) => !maps.fontSkips.has(token.variable))
      .map((token) => {
        const renamed = maps.fontRenames.get(token.variable)
        return renamed ? { ...token, variable: renamed } : token
      }),
  }
}

/** Whether a resolution moves the item to a new name (rather than skip/overwrite). */
function isRename(res: ConflictResolution): boolean {
  return res.action === 'auto-rename' || res.action === 'custom-rename'
}

/**
 * Rewrite a fragment's nodes through a class-name rename map (applied to
 * `classIds`) and a token-variable rename map (applied to `var(--x)` references
 * in `inlineStyles`). Returns the SAME fragment reference when nothing changes.
 */
function remapFragment(
  fragment: ImportFragment,
  classRenames: Map<string, string>,
  varRenames: Map<string, string>,
): ImportFragment {
  if (classRenames.size === 0 && varRenames.size === 0) return fragment

  let changed = false
  const nodes: Record<string, PageNode> = {}
  for (const [id, node] of Object.entries(fragment.nodes)) {
    const next = remapNodeRefs(node, classRenames, varRenames)
    if (next !== node) changed = true
    nodes[id] = next
  }

  let body = fragment.body
  if (body) {
    const nextBody = remapNodeRefs(body, classRenames, varRenames)
    if (nextBody !== body) {
      changed = true
      body = nextBody
    }
  }

  return changed ? { nodes, rootIds: fragment.rootIds, ...(body ? { body } : {}) } : fragment
}

/**
 * Remap one node-like value (a fragment node or the fragment body): class
 * tokens in `classIds` follow class renames; `var(--x)` references in
 * `inlineStyles` follow token renames. Returns the SAME reference when
 * nothing changed so callers can cheaply detect no-ops.
 */
function remapNodeRefs<T extends { classIds?: string[]; inlineStyles?: PageNode['inlineStyles'] }>(
  node: T,
  classRenames: Map<string, string>,
  varRenames: Map<string, string>,
): T {
  let next = node
  if (classRenames.size > 0 && next.classIds?.length) {
    const classIds = next.classIds.map((name) => classRenames.get(name) ?? name)
    if (classIds.some((name, i) => name !== next.classIds![i])) {
      next = { ...next, classIds }
    }
  }
  if (varRenames.size > 0 && next.inlineStyles && Object.keys(next.inlineStyles).length > 0) {
    const inlineStyles = rewriteStyleBagVarRefs(next.inlineStyles, varRenames)
    if (inlineStyles !== next.inlineStyles) next = { ...next, inlineStyles }
  }
  return next
}

function rewriteAmbientRuleClassRefs(
  rule: NewStyleRule,
  classRenames: Map<string, string>,
): NewStyleRule {
  if (rule.kind !== 'ambient' || typeof rule.rawCss === 'string') return rule
  const selector = rewriteSelectorClasses(rule.selector, classRenames)
  if (selector === rule.selector) return rule
  return {
    ...rule,
    selector,
    name: rule.name === rule.selector ? selector : rule.name,
  }
}

const SELECTOR_CLASS_TOKEN_RE = /\.(-?[A-Za-z_][\w-]*)/g

function rewriteSelectorClasses(selector: string, classRenames: Map<string, string>): string {
  return selector.replace(SELECTOR_CLASS_TOKEN_RE, (whole, token: string) => {
    const renamed = classRenames.get(token)
    return renamed && renamed !== token ? `.${renamed}` : whole
  })
}

/**
 * Rewrite `var(--old)` → `var(--new)` references inside a style rule's base
 * `styles` and every `contextStyles` bag. Returns the same rule when no value
 * changes.
 */
function rewriteRuleVarRefs(rule: NewStyleRule, renames: Map<string, string>): NewStyleRule {
  const styles = rewriteStyleBagVarRefs(rule.styles, renames)
  const rawCss = typeof rule.rawCss === 'string'
    ? rewriteCssVarRefs(rule.rawCss, renames)
    : rule.rawCss
  let contextStyles = rule.contextStyles
  if (contextStyles && Object.keys(contextStyles).length > 0) {
    let ctxChanged = false
    const nextCtx: Record<string, Record<string, unknown>> = {}
    for (const [ctxId, bag] of Object.entries(contextStyles)) {
      const nextBag = rewriteStyleBagVarRefs(bag as Record<string, unknown>, renames)
      if (nextBag !== bag) ctxChanged = true
      nextCtx[ctxId] = nextBag
    }
    if (ctxChanged) contextStyles = nextCtx as NewStyleRule['contextStyles']
  }
  return styles === rule.styles && contextStyles === rule.contextStyles && rawCss === rule.rawCss
    ? rule
    : {
        ...rule,
        styles: styles as NewStyleRule['styles'],
        contextStyles,
        ...(rawCss !== undefined ? { rawCss } : {}),
      }
}

/**
 * Rewrite `var(--old)` references in every string value of a style bag. Returns
 * the same object reference when nothing changes.
 */
function rewriteStyleBagVarRefs<T extends Record<string, unknown>>(
  bag: T,
  renames: Map<string, string>,
): T {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === 'string') {
      const next = rewriteCssVarRefs(value, renames)
      if (next !== value) changed = true
      out[key] = next
    } else {
      out[key] = value
    }
  }
  return changed ? (out as T) : bag
}

// Matches `var(--name` (optional leading whitespace), capturing the bare
// custom-property name. The fallback/closing-paren tail is left untouched.
const VAR_REF_RE = /var\(\s*--([A-Za-z0-9_-]+)/g

/** Rewrite `var(--old)` → `var(--new)` for every name in `renames`. */
function rewriteCssVarRefs(value: string, renames: Map<string, string>): string {
  if (renames.size === 0 || !value.includes('var(')) return value
  return value.replace(VAR_REF_RE, (match, name: string) => {
    const next = renames.get(name)
    return next ? match.replace(`--${name}`, `--${next}`) : match
  })
}
