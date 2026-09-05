import type { RegistryPackageDetails } from '@core/registry'

/**
 * What the install picker offers, in the order it offers them: `latest`
 * first, then the other dist-tags, then the newest non-deprecated releases.
 *
 * The order matters because the first entry is the one-click default.
 * `dist-tags` key order is whatever the registry's JSON happens to be, and for
 * many packages that is a years-old `dev`, `beta` or `next` tag — installing
 * it unasked would pin the site to a prerelease.
 */
export function versionChoices(details: RegistryPackageDetails): string[] {
  const otherTags = Object.entries(details.distTags)
    .filter(([tag]) => tag !== 'latest')
    .map(([, version]) => version)
  const recent = details.versions.filter((info) => !info.deprecated).map((info) => info.version)
  // Dist-tags come before the release list: it is capped, and a `next` or
  // `beta` build would otherwise be cut from a package with many releases.
  const ordered = [details.latest, ...otherTags, ...recent].filter((version) => version !== '')
  return [...new Set(ordered)].slice(0, 30)
}
