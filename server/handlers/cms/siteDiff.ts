/**
 * Site-shell write diff validator — enforces granular capabilities on PUT /admin/api/cms/site.
 *
 * The save endpoint accepts the site shell and replaces the draft.
 * To support a "Client" role with `site.content.edit` only, we walk the diff
 * between the previously stored shell and the incoming one, and reject any
 * change whose category isn't covered by the caller's capabilities.
 *
 * Change categories
 *   structure — adding / removing / reordering breakpoints, managing files,
 *               toggling fileTypes, modifying packageJson/runtime,
 *               changing site id / name.
 *   content   — settings.seo (authored site-wide SEO copy
 *               the "client / copy editor" persona owns).
 *   style     — classes registry contents, settings.framework, settings.fonts,
 *               file contents.
 *
 * Pages are NOT diffed here (managed by /pages endpoint).
 * Visual Components are NOT diffed here (managed as data_rows via /components
 * endpoint). VC changes are implicitly structural but gated at that endpoint.
 *
 * Capability ↔ category mapping
 *   site.structure.edit → structure
 *   site.content.edit   → content
 *   site.style.edit     → style
 *
 * First-save semantics: when there is no previous shell (`previous === null`),
 * the incoming document is treated as a structural change in its entirety —
 * a content-only caller cannot bootstrap a site from nothing.
 */
import type { CoreCapability } from '../../auth/capabilities'
import type {
  StyleRule,
  SiteShell,
} from '@core/page-tree'

type SiteChangeKind = 'structure' | 'content' | 'style'

export class ForbiddenSiteChangeError extends Error {
  // The TS `erasableSyntaxOnly` lint forbids constructor-parameter properties,
  // so the public fields are declared on the class body instead.
  readonly kind: SiteChangeKind
  readonly path: string
  readonly detail: string

  constructor(kind: SiteChangeKind, path: string, detail: string) {
    super(`forbidden ${kind} change at ${path}: ${detail}`)
    this.name = 'ForbiddenSiteChangeError'
    this.kind = kind
    this.path = path
    this.detail = detail
  }
}

const CAP_FOR_KIND: Record<SiteChangeKind, CoreCapability> = {
  structure: 'site.structure.edit',
  content: 'site.content.edit',
  style: 'site.style.edit',
}

interface DiffContext {
  capabilities: readonly CoreCapability[]
}

function allowed(ctx: DiffContext, kind: SiteChangeKind): boolean {
  return ctx.capabilities.includes(CAP_FOR_KIND[kind])
}

function fail(kind: SiteChangeKind, path: string, detail: string): never {
  throw new ForbiddenSiteChangeError(kind, path, detail)
}

function requireChange(ctx: DiffContext, kind: SiteChangeKind, path: string, detail: string): void {
  if (!allowed(ctx, kind)) fail(kind, path, detail)
}

/**
 * Validate the diff between `previous` and `next` shell against the caller's
 * capabilities. Throws `ForbiddenSiteChangeError` on the first disallowed
 * change. No-ops when the caller holds all three site-write capabilities.
 *
 * Pages are NOT included in the diff — they are managed by the /pages endpoint.
 */
export function validateSiteWriteDiff(
  previous: SiteShell | null,
  next: SiteShell,
  capabilities: readonly CoreCapability[],
): void {
  // Fast path: a caller with the full set never needs the diff — they can
  // make any change. Saves cycles on the common case.
  if (
    capabilities.includes('site.structure.edit') &&
    capabilities.includes('site.content.edit') &&
    capabilities.includes('site.style.edit')
  ) {
    return
  }

  const ctx: DiffContext = { capabilities }

  // First save: a content-only caller cannot create the site from nothing.
  // Treat the whole document as a structural change.
  if (!previous) {
    requireChange(ctx, 'structure', '', 'no previous draft — full site create requires site.structure.edit')
    return
  }

  // Top-level meta — id and name changes are structural.
  if (previous.id !== next.id) {
    requireChange(ctx, 'structure', 'id', `${previous.id} → ${next.id}`)
  }
  if (previous.name !== next.name) {
    requireChange(ctx, 'structure', 'name', `"${previous.name}" → "${next.name}"`)
  }

  // Settings — split into chromatic-style fields (framework/fonts) and
  // content (seo) and structural fields (favicon/language/shortcuts).
  diffSettings(ctx, previous.settings, next.settings)

  // breakpoints — adding / removing / reordering is style infra.
  if (!deepEqual(previous.breakpoints, next.breakpoints)) {
    requireChange(ctx, 'style', 'breakpoints', 'breakpoint list changed')
  }

  // packageJson + runtime — deployment-level, structural.
  if (!deepEqual(previous.packageJson, next.packageJson)) {
    requireChange(ctx, 'structure', 'packageJson', 'package manifest changed')
  }
  if (!deepEqual(previous.runtime, next.runtime)) {
    requireChange(ctx, 'structure', 'runtime', 'runtime config changed')
  }

  // styleRules registry — every change is style. Add/remove/rename always counts
  // as style; mutation of an entry's styles bag is style.
  diffClassesMap(ctx, previous.styleRules, next.styleRules)

  // files — added/removed/renamed entries are structural; in-place content
  // edits to a `css`/`script` file are style; everything else is structural.
  diffFiles(ctx, previous.files, next.files)

  // Visual Components are no longer in the site shell — they live in
  // data_rows (table_id = 'components') and are managed via /admin/api/cms/components.
  // No VC diff here.
}

// ---------------------------------------------------------------------------
// settings diff
// ---------------------------------------------------------------------------

function diffSettings(
  ctx: DiffContext,
  prev: SiteShell['settings'],
  next: SiteShell['settings'],
): void {
  // Style-side fields.
  if (!deepEqual(prev.framework, next.framework)) {
    requireChange(ctx, 'style', 'settings.framework', 'framework tokens changed')
  }
  if (!deepEqual(prev.fonts, next.fonts)) {
    requireChange(ctx, 'style', 'settings.fonts', 'fonts library changed')
  }

  // Content fields — site-wide SEO copy that the copy-editor persona owns.
  const contentKeys: Array<keyof SiteShell['settings']> = [
    'seo',
  ]
  for (const key of contentKeys) {
    if (!deepEqual(prev[key], next[key])) {
      requireChange(ctx, 'content', `settings.${String(key)}`, `${String(key)} changed`)
    }
  }

  // Structural fields — install identity / runtime config / editor prefs.
  const structuralKeys: Array<keyof SiteShell['settings']> = [
    'faviconUrl',
    'language',
    'shortcuts',
  ]
  for (const key of structuralKeys) {
    if (!deepEqual(prev[key], next[key])) {
      requireChange(ctx, 'structure', `settings.${String(key)}`, `${String(key)} changed`)
    }
  }
}

// ---------------------------------------------------------------------------
// classes diff
// ---------------------------------------------------------------------------

function diffClassesMap(
  ctx: DiffContext,
  prev: Record<string, StyleRule>,
  next: Record<string, StyleRule>,
): void {
  const allIds = new Set([...Object.keys(prev), ...Object.keys(next)])
  for (const id of allIds) {
    const a = prev[id]
    const b = next[id]
    if (!a || !b) {
      // add or remove
      requireChange(ctx, 'style', `styleRules.${id}`, a ? 'removed' : 'added')
      continue
    }
    if (!deepEqual(a, b)) {
      requireChange(ctx, 'style', `styleRules.${id}`, 'style rule changed')
    }
  }
}

// ---------------------------------------------------------------------------
// files diff
// ---------------------------------------------------------------------------

function diffFiles(
  ctx: DiffContext,
  prev: SiteShell['files'],
  next: SiteShell['files'],
): void {
  const prevById = new Map(prev.map((f) => [f.id, f]))
  const nextById = new Map(next.map((f) => [f.id, f]))
  for (const id of new Set([...prevById.keys(), ...nextById.keys()])) {
    const a = prevById.get(id)
    const b = nextById.get(id)
    if (!a || !b) {
      requireChange(ctx, 'structure', `files.${id}`, a ? 'removed' : 'added')
      continue
    }
    if (a.path !== b.path || a.type !== b.type) {
      requireChange(ctx, 'structure', `files.${id}`, 'renamed or retyped')
    }
    if (a.content !== b.content) {
      // CSS / JS body edit is a style change; everything else is structural.
      const kind: SiteChangeKind = a.type === 'style' || a.type === 'script' ? 'style' : 'structure'
      requireChange(ctx, kind, `files.${id}.content`, 'file contents changed')
    }
  }
}

// ---------------------------------------------------------------------------
// Small deep-equal helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
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
