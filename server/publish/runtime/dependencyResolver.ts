import { maxSatisfying } from 'semver'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import type {
  LockedSiteDependency,
  SiteDependencyLock,
} from '@core/site-runtime'
import { RegistryUpstreamError, getInstallPackument } from '../../registry/client'
import type { Packument } from '../../registry/upstream'

interface ResolveSiteDependencyLockOptions {
  /** Injectable fetch — test seam, forwarded to the registry client. */
  fetch?: typeof fetch
  now?: () => number
}

/**
 * How many packuments to pull at once. Install documents are still megabytes,
 * and registries throttle: a manifest with thirty dependencies must not open
 * thirty simultaneous downloads and earn a 429 for the whole resolve.
 */
const RESOLVE_CONCURRENCY = 5

function normalizeRequestedRange(requested: string): string {
  const trimmed = requested.trim()
  return trimmed && trimmed !== 'latest' ? trimmed : '*'
}

function resolveVersion(metadata: Packument, requested: string): string {
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

  const now = options.now ?? Date.now
  let metadata: Packument
  try {
    // Always a fresh document: an install must see a version the moment it is
    // published, so the resolver never reads the browsing cache.
    metadata = await getInstallPackument(safeName, { fetchImpl: options.fetch })
  } catch (err) {
    if (err instanceof RegistryUpstreamError) {
      const detail = err.status ?? err.message
      throw new Error(`[runtime dependencies] Failed to resolve ${safeName}: ${detail}`, { cause: err })
    }
    throw err
  }

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

/** Run `worker` over `items`, at most `limit` at a time, keeping input order. */
async function mapWithLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(runners)
  return results
}

export async function resolveSiteDependencyLock(
  packageJson: SitePackageJson,
  options: ResolveSiteDependencyLockOptions = {},
): Promise<SiteDependencyLock> {
  const now = options.now ?? Date.now
  const entries = Object.entries(packageJson.dependencies)
  const settled = await mapWithLimit(entries, RESOLVE_CONCURRENCY, ([name, requested]) =>
    resolveRuntimeDependency(name, requested, options),
  )

  // Report every package that failed, not just whichever lost the race: a
  // manifest with two bad names should not need two resolve attempts to
  // surface both.
  const failures = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length > 0) {
    const messages = failures.map((reason) => (reason instanceof Error ? reason.message : String(reason)))
    throw new Error(messages.join('; '), { cause: failures[0] })
  }

  const packages: Record<string, LockedSiteDependency> = {}
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    packages[result.value.name] = result.value
  }

  return {
    version: 1,
    packages,
    updatedAt: now(),
  }
}
