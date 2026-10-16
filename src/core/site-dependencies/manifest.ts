import { Type, type Static } from '@sinclair/typebox'
import { withFallback } from '@core/utils/typeboxHelpers'
import { isSafePackageName } from './packageNames'

// ---------------------------------------------------------------------------
// SitePackageJsonSchema — thin schema for the site's package manifest shape.
//
// NOTE: normalizeSitePackageJson (below) also filters unsafe package names via
// isSafePackageName(). That per-entry sanitisation is intentionally NOT in
// this schema because fallback handling would silently discard the entire
// dependencies map on any failure. Instead, name sanitisation runs in
// validate.ts::runDomainPostChecks via normalizeSitePackageJson after parsing.
// The schema captures the structural shape and is used as the
// persistence-boundary type source of truth.
// ---------------------------------------------------------------------------

export const SitePackageJsonSchema = withFallback(
  Type.Object({
    dependencies: withFallback(Type.Record(Type.String(), Type.String()), {}),
    devDependencies: withFallback(Type.Record(Type.String(), Type.String()), {}),
  }),
  { dependencies: {}, devDependencies: {} },
)

export type SitePackageJson = Static<typeof SitePackageJsonSchema>

/**
 * Empty default. The dependencies feature is opt-in: a fresh site has no
 * runtime packages until the user adds them through the Dependencies panel.
 *
 * Builder-only packages (TypeScript, Vite, type packages) used to live here as
 * devDependency defaults but they are not site runtime packages and should
 * never have leaked into a user's manifest. See the runtime dependencies
 * design doc, "Dependency Semantics".
 */
export const DEFAULT_SITE_PACKAGE_JSON: SitePackageJson = {
  dependencies: {},
  devDependencies: {},
}

/** Which bucket a package is declared in, and at what range. Null when the manifest does not list it. */
export interface DeclaredDependency {
  range: string
  dev: boolean
}

/**
 * Read one declared dependency.
 *
 * `Object.hasOwn`, never `in` or a bare bracket read: `isSafePackageName`
 * accepts names like `constructor` and `toString`, and the dependency maps are
 * plain objects, so a prototype property would otherwise read as an installed
 * package with a `Function` for a version.
 */
export function readDeclaredDependency(packageJson: SitePackageJson, name: string): DeclaredDependency | null {
  if (Object.hasOwn(packageJson.dependencies, name)) return { range: packageJson.dependencies[name], dev: false }
  if (Object.hasOwn(packageJson.devDependencies, name)) return { range: packageJson.devDependencies[name], dev: true }
  return null
}

/** Whether the manifest declares `name` in the given bucket. */
export function hasDeclaredDependency(packageJson: SitePackageJson, name: string, dev: boolean): boolean {
  const bucket = dev ? packageJson.devDependencies : packageJson.dependencies
  return Object.hasOwn(bucket, name)
}

export function clonePackageJson(
  packageJson: SitePackageJson = DEFAULT_SITE_PACKAGE_JSON,
): SitePackageJson {
  return {
    dependencies: { ...packageJson.dependencies },
    devDependencies: { ...packageJson.devDependencies },
  }
}

function normalizeDependencyMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const normalized: Record<string, string> = {}
  for (const [rawName, rawVersion] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim()
    const version = typeof rawVersion === 'string' ? rawVersion.trim() : ''
    if (!name || !version || !isSafePackageName(name)) continue
    normalized[name] = version
  }
  return normalized
}

export function normalizeSitePackageJson(raw: unknown): SitePackageJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return clonePackageJson()
  }

  // The user manifest is authoritative — we used to spread defaults *over* it,
  // which meant a user could never actually remove a default-listed package
  // (it would silently reappear on every load). Defaults only fill in the
  // entirely-missing case handled above.
  const manifest = raw as Record<string, unknown>
  return {
    dependencies: normalizeDependencyMap(manifest.dependencies),
    devDependencies: normalizeDependencyMap(manifest.devDependencies),
  }
}
