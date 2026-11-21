/**
 * Package-name validation shared by dependency UI, module manifests, and export.
 * Keeps package manifest writes data-only and safe for the future bridge layer.
 */

const SAFE_PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export function isSafePackageName(name: string): boolean {
  return SAFE_PACKAGE_NAME.test(name)
}

/** A concrete npm version or dist-tag as it may appear in a URL or an OSV query. */
const SAFE_PACKAGE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/

export function isSafePackageVersion(version: string): boolean {
  return SAFE_PACKAGE_VERSION.test(version)
}
