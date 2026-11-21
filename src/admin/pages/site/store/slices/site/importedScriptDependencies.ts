/**
 * importedScriptDependencies — the npm packages imported scripts load from a
 * CDN (`ImportScript.dependencies`, already rewritten to bare imports in the
 * script text) and how they land in `site.packageJson.dependencies`.
 *
 * A new script only adds packages the site does not list yet. A replaced
 * script may move a listed package to the version it now asks for, but only
 * when that is safe: never to an unpinned `*` or a looser range than a pin,
 * never while another site script still imports the package, and never when
 * two replaced scripts disagree. Those cases keep the listed version and say
 * so with a `dependency-version-kept` warning. Packages no script uses any
 * more are never removed; the Dependencies panel does that.
 */

import { valid as validVersion } from 'semver'
import { extractRuntimeImportSpecifiers, packageNameFromImportSpecifier } from '@core/site-runtime'
import type { Draft } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import type { ImportScript, ImportWarning } from '@core/siteImport'
import { isSafePackageName } from '@core/site-dependencies/packageNames'

/** Add packages new scripts import that package.json does not list yet. */
export function addImportedScriptDependencies(
  site: Draft<SiteDocument>,
  scripts: ImportScript[],
): boolean {
  let changed = false
  for (const script of scripts) {
    for (const dependency of script.dependencies ?? []) {
      if (!isSafePackageName(dependency.name)) continue
      if (site.packageJson.dependencies[dependency.name]) continue
      listDependency(site, dependency.name, dependency.version.trim() || '*')
      changed = true
    }
  }
  return changed
}

/**
 * The packages of scripts being replaced in place (`replacing`, keyed by the
 * site file id they replace). Unlisted packages are added like a new
 * script's; a listed one moves to the requested version only when safe.
 */
export function replaceImportedScriptDependencies(
  site: Draft<SiteDocument>,
  replacing: { fileId: string; script: ImportScript }[],
): { changed: boolean; warnings: ImportWarning[] } {
  const requested = new Map<string, Set<string>>()
  for (const { script } of replacing) {
    for (const dependency of script.dependencies ?? []) {
      if (!isSafePackageName(dependency.name)) continue
      const versions = requested.get(dependency.name) ?? new Set<string>()
      versions.add(dependency.version.trim() || '*')
      requested.set(dependency.name, versions)
    }
  }

  if (requested.size === 0) return { changed: false, warnings: [] }
  const replacedIds = new Set(replacing.map(({ fileId }) => fileId))
  const usedElsewhere = new Set<string>()
  for (const file of site.files) {
    if (file.type !== 'script' || replacedIds.has(file.id)) continue
    for (const { specifier } of extractRuntimeImportSpecifiers(file.content ?? '')) {
      const name = packageNameFromImportSpecifier(specifier)
      if (name) usedElsewhere.add(name)
    }
  }
  const warnings: ImportWarning[] = []
  let changed = false
  const keep = (name: string, why: string) => {
    warnings.push({
      kind: 'dependency-version-kept',
      message: `Kept ${name}@${site.packageJson.dependencies[name]} in package.json: ${why}`,
      path: name,
    })
  }

  for (const [name, versions] of requested) {
    const listed = site.packageJson.dependencies[name]
    const [first] = versions
    if (!listed) {
      listDependency(site, name, first!)
      changed = true
      if (versions.size > 1) keep(name, `the imported scripts ask for ${[...versions].join(' and ')}`)
      continue
    }
    if (versions.size > 1) {
      keep(name, `the replaced scripts ask for ${[...versions].join(' and ')}`)
      continue
    }
    if (first === listed || first === '*') continue
    if (validVersion(listed) && !validVersion(first!)) {
      keep(name, `the replaced script asks for ${first}, which is looser than the pinned version`)
      continue
    }
    if (usedElsewhere.has(name)) {
      keep(name, `the replaced script asks for ${first}, but other scripts in the site still import it`)
      continue
    }
    listDependency(site, name, first!)
    changed = true
  }
  return { changed, warnings }
}

function listDependency(site: Draft<SiteDocument>, name: string, version: string): void {
  site.packageJson.dependencies[name] = version
  if (site.packageJson.devDependencies[name]) delete site.packageJson.devDependencies[name]
}
