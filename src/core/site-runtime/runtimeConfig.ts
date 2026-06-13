import { isSafePackageName } from '@core/site-dependencies/packageNames'
import type { Page } from '@core/page-tree'
import type { SiteFile } from '@core/files/schemas'
import type {
  LockedSiteDependency,
  RuntimePackageImportmap,
  SiteAssetScope,
  SiteDependencyLock,
  SiteRuntimeConfig,
  SiteRuntimeTarget,
  SiteScriptRuntimeConfig,
  SiteStyleRuntimeConfig,
} from './schemas'

/**
 * Input shape for `collectRuntimeScripts`. Lives here (next to the function)
 * rather than in `./types` so the type module stays free of `page-tree` imports
 * and the runtime/page-tree type cycle is broken.
 */
interface CollectRuntimeScriptsInput {
  files: SiteFile[]
  runtime: SiteRuntimeConfig
  page: Page
  target: SiteRuntimeTarget
}

/** Input shape for `collectAppliedStyles` — the stylesheet analogue. */
interface CollectAppliedStylesInput {
  files: SiteFile[]
  runtime: SiteRuntimeConfig
  page: Page
}

const DEFAULT_SITE_DEPENDENCY_LOCK: SiteDependencyLock = {
  version: 1,
  packages: {},
  updatedAt: 0,
}

export const DEFAULT_SCRIPT_RUNTIME_CONFIG: SiteScriptRuntimeConfig = {
  enabled: true,
  runInCanvas: true,
  format: 'module',
  placement: 'body-end',
  timing: 'dom-ready',
  scope: { type: 'all-pages' },
  priority: 100,
}

export const DEFAULT_STYLE_RUNTIME_CONFIG: SiteStyleRuntimeConfig = {
  enabled: true,
  scope: { type: 'all-pages' },
  priority: 100,
}

export const DEFAULT_SITE_RUNTIME: SiteRuntimeConfig = {
  dependencyLock: DEFAULT_SITE_DEPENDENCY_LOCK,
  scripts: {},
  styles: {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Normalise the shared scope union used by both scripts and stylesheets.
 * Unknown / malformed input collapses to `all-pages` — the safe default that
 * applies an asset everywhere.
 */
function normalizeAssetScope(raw: unknown): SiteAssetScope {
  if (!isRecord(raw)) return { type: 'all-pages' }
  if (raw.type === 'pages') return { type: 'pages', pageIds: stringArray(raw.pageIds) }
  if (raw.type === 'templates') return { type: 'templates', templatePageIds: stringArray(raw.templatePageIds) }
  return { type: 'all-pages' }
}

export function normalizeScriptRuntimeConfig(raw: unknown): SiteScriptRuntimeConfig {
  if (!isRecord(raw)) return { ...DEFAULT_SCRIPT_RUNTIME_CONFIG }

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SCRIPT_RUNTIME_CONFIG.enabled,
    runInCanvas: typeof raw.runInCanvas === 'boolean' ? raw.runInCanvas : DEFAULT_SCRIPT_RUNTIME_CONFIG.runInCanvas,
    format: raw.format === 'classic' || raw.format === 'module'
      ? raw.format
      : DEFAULT_SCRIPT_RUNTIME_CONFIG.format,
    placement: raw.placement === 'head' || raw.placement === 'body-end'
      ? raw.placement
      : DEFAULT_SCRIPT_RUNTIME_CONFIG.placement,
    timing: raw.timing === 'immediate' || raw.timing === 'dom-ready' || raw.timing === 'idle'
      ? raw.timing
      : DEFAULT_SCRIPT_RUNTIME_CONFIG.timing,
    scope: normalizeAssetScope(raw.scope),
    priority: finiteNumberOr(raw.priority, DEFAULT_SCRIPT_RUNTIME_CONFIG.priority),
  }
}

export function normalizeStyleRuntimeConfig(raw: unknown): SiteStyleRuntimeConfig {
  if (!isRecord(raw)) return { ...DEFAULT_STYLE_RUNTIME_CONFIG }

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_STYLE_RUNTIME_CONFIG.enabled,
    scope: normalizeAssetScope(raw.scope),
    priority: finiteNumberOr(raw.priority, DEFAULT_STYLE_RUNTIME_CONFIG.priority),
  }
}

function normalizeLockedDependency(rawKey: string, raw: unknown): LockedSiteDependency | null {
  const key = rawKey.trim()
  if (!key || !isSafePackageName(key) || !isRecord(raw)) return null

  const requested = typeof raw.requested === 'string' && raw.requested.trim()
    ? raw.requested.trim()
    : ''
  const version = typeof raw.version === 'string' && raw.version.trim()
    ? raw.version.trim()
    : ''
  if (!requested || !version) return null

  return {
    name: key,
    requested,
    version,
    ...(typeof raw.integrity === 'string' && raw.integrity.trim() ? { integrity: raw.integrity.trim() } : {}),
    ...(typeof raw.tarballUrl === 'string' && raw.tarballUrl.trim() ? { tarballUrl: raw.tarballUrl.trim() } : {}),
    resolvedAt: finiteNumberOr(raw.resolvedAt, 0),
  }
}

function normalizeDependencyLock(raw: unknown): SiteDependencyLock {
  if (!isRecord(raw)) return { ...DEFAULT_SITE_DEPENDENCY_LOCK, packages: {} }

  const packages: Record<string, LockedSiteDependency> = {}
  if (isRecord(raw.packages)) {
    for (const [name, value] of Object.entries(raw.packages)) {
      const dependency = normalizeLockedDependency(name, value)
      if (dependency) packages[dependency.name] = dependency
    }
  }

  return {
    version: 1,
    packages,
    updatedAt: finiteNumberOr(raw.updatedAt, 0),
  }
}

function normalizePackageImportmap(raw: unknown): RuntimePackageImportmap | undefined {
  if (!isRecord(raw)) return undefined
  const lockHash = typeof raw.lockHash === 'string' && raw.lockHash.trim() ? raw.lockHash.trim() : ''
  if (!lockHash) return undefined
  const importsRaw = isRecord(raw.imports) ? raw.imports : null
  if (!importsRaw) return undefined
  const imports: Record<string, string> = {}
  for (const [key, value] of Object.entries(importsRaw)) {
    if (typeof key === 'string' && key.length > 0 && typeof value === 'string' && value.length > 0) {
      imports[key] = value
    }
  }
  if (Object.keys(imports).length === 0) return undefined
  return { imports, lockHash }
}

export function normalizeSiteRuntimeConfig(raw: unknown): SiteRuntimeConfig {
  if (!isRecord(raw)) {
    return { dependencyLock: { ...DEFAULT_SITE_DEPENDENCY_LOCK, packages: {} }, scripts: {}, styles: {} }
  }

  const scripts: Record<string, SiteScriptRuntimeConfig> = {}
  if (isRecord(raw.scripts)) {
    for (const [fileId, value] of Object.entries(raw.scripts)) {
      if (fileId.trim()) scripts[fileId] = normalizeScriptRuntimeConfig(value)
    }
  }

  const styles: Record<string, SiteStyleRuntimeConfig> = {}
  if (isRecord(raw.styles)) {
    for (const [fileId, value] of Object.entries(raw.styles)) {
      if (fileId.trim()) styles[fileId] = normalizeStyleRuntimeConfig(value)
    }
  }

  const packageImportmap = normalizePackageImportmap(raw.packageImportmap)
  return {
    dependencyLock: normalizeDependencyLock(raw.dependencyLock),
    scripts,
    styles,
    ...(packageImportmap ? { packageImportmap } : {}),
  }
}

export function cloneSiteRuntimeConfig(runtime: SiteRuntimeConfig = DEFAULT_SITE_RUNTIME): SiteRuntimeConfig {
  return normalizeSiteRuntimeConfig(runtime)
}

/**
 * Whether an asset (script or stylesheet) with the given scope applies to a
 * page. Shared by `collectRuntimeScripts` and `collectAppliedStyles` so the
 * two surfaces can never drift on "does this target page X?".
 */
export function assetScopeAppliesToPage(
  scope: SiteAssetScope,
  page: { id: string; template?: unknown },
): boolean {
  if (scope.type === 'all-pages') return true
  if (scope.type === 'pages') return scope.pageIds.includes(page.id)
  return Boolean(page.template) && scope.templatePageIds.includes(page.id)
}

export function collectRuntimeScripts({
  files,
  runtime,
  page,
  target,
}: CollectRuntimeScriptsInput) {
  return files
    .filter((file) => file.type === 'script')
    .map((file) => ({
      file,
      config: runtime.scripts[file.id] ?? { ...DEFAULT_SCRIPT_RUNTIME_CONFIG },
    }))
    .filter(({ config }) => config.enabled)
    .filter(({ config }) => target !== 'canvas' || config.runInCanvas)
    .filter(({ config }) => assetScopeAppliesToPage(config.scope, page))
    .sort((a, b) => {
      const priority = a.config.priority - b.config.priority
      return priority || a.file.path.localeCompare(b.file.path)
    })
}

/**
 * Select the user stylesheets that apply to `page`, ordered for the cascade:
 * ascending `priority` first, then `path` for stable tie-breaking. Disabled
 * stylesheets and ones whose scope excludes the page are dropped. Empty-bodied
 * files are skipped — an empty `<link>`/concatenation entry is wasted bytes.
 */
export function collectAppliedStyles({
  files,
  runtime,
  page,
}: CollectAppliedStylesInput): Array<{ file: SiteFile; config: SiteStyleRuntimeConfig }> {
  return files
    .filter((file) => file.type === 'style' && typeof file.content === 'string' && file.content.length > 0)
    .map((file) => ({
      file,
      config: runtime.styles[file.id] ?? { ...DEFAULT_STYLE_RUNTIME_CONFIG },
    }))
    .filter(({ config }) => config.enabled)
    .filter(({ config }) => assetScopeAppliesToPage(config.scope, page))
    .sort((a, b) => {
      const priority = a.config.priority - b.config.priority
      return priority || a.file.path.localeCompare(b.file.path)
    })
}
