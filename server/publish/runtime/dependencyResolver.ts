import { maxSatisfying } from 'semver'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import type {
  LockedSiteDependency,
  SiteDependencyLock,
} from '@core/site-runtime'

// Validates the npm registry response. Permissive on extra fields (npm's
// metadata schema is large and we only consume the fields below). Surfaced
// by /audit-types — was `await response.json() as NpmPackageMetadata`.
const NpmPackageMetadataSchema = Type.Object({
  name: Type.Optional(Type.String()),
  'dist-tags': Type.Optional(Type.Record(Type.String(), Type.String())),
  versions: Type.Optional(Type.Record(
    Type.String(),
    Type.Object({
      dist: Type.Optional(Type.Object({
        integrity: Type.Optional(Type.String()),
        tarball: Type.Optional(Type.String()),
      }, { additionalProperties: true })),
    }, { additionalProperties: true }),
  )),
}, { additionalProperties: true })

type NpmPackageMetadata = Static<typeof NpmPackageMetadataSchema>

interface ResolveSiteDependencyLockOptions {
  fetch?: typeof fetch
  now?: () => number
  registryUrl?: string
}

function registryPackageUrl(registryUrl: string, packageName: string): string {
  const encoded = packageName.startsWith('@')
    ? packageName.replace('/', '%2f')
    : encodeURIComponent(packageName)
  return `${registryUrl.replace(/\/$/, '')}/${encoded}`
}

function normalizeRequestedRange(requested: string): string {
  const trimmed = requested.trim()
  return trimmed && trimmed !== 'latest' ? trimmed : '*'
}

function resolveVersion(metadata: NpmPackageMetadata, requested: string): string {
  const versions = Object.keys(metadata.versions ?? {})
  if (versions.length === 0) {
    throw new Error(`[runtime dependencies] No versions found for ${metadata.name ?? 'package'}`)
  }

  const range = normalizeRequestedRange(requested)
  if (range === '*') {
    const latest = metadata['dist-tags']?.latest
    if (latest && metadata.versions?.[latest]) return latest
  }

  const version = maxSatisfying(versions, range)
  if (!version) {
    throw new Error(`[runtime dependencies] No version satisfies ${metadata.name ?? 'package'}@${requested}`)
  }
  return version
}

async function resolveRuntimeDependency(
  name: string,
  requested: string,
  options: ResolveSiteDependencyLockOptions = {},
): Promise<LockedSiteDependency> {
  const safeName = name.trim()
  if (!isSafePackageName(safeName)) {
    throw new Error(`[runtime dependencies] Invalid package name "${name}"`)
  }

  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const response = await fetchImpl(registryPackageUrl(options.registryUrl ?? 'https://registry.npmjs.org', safeName))
  if (!response.ok) {
    throw new Error(`[runtime dependencies] Failed to resolve ${safeName}: ${response.status}`)
  }

  const metadata = await parseJsonResponse(response, NpmPackageMetadataSchema)
  const version = resolveVersion(metadata, requested)
  const dist = metadata.versions?.[version]?.dist
  const resolvedAt = now()

  return {
    name: safeName,
    requested: requested.trim() || '*',
    version,
    ...(dist?.integrity ? { integrity: dist.integrity } : {}),
    ...(dist?.tarball ? { tarballUrl: dist.tarball } : {}),
    resolvedAt,
  }
}

export async function resolveSiteDependencyLock(
  packageJson: SitePackageJson,
  options: ResolveSiteDependencyLockOptions = {},
): Promise<SiteDependencyLock> {
  const packages: Record<string, LockedSiteDependency> = {}
  const now = options.now ?? Date.now

  for (const [name, requested] of Object.entries(packageJson.dependencies)) {
    const locked = await resolveRuntimeDependency(name, requested, options)
    packages[locked.name] = locked
  }

  return {
    version: 1,
    packages,
    updatedAt: now(),
  }
}
