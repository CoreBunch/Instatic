import type { AnyModuleDefinition, IModuleRegistry, ModuleDependencies } from './types'
import { readDeclaredDependency, type SitePackageJson } from '@core/site-dependencies/manifest'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import type { BaseNode } from '@core/page-tree-schema'

export interface NormalizedModuleDependency {
  name: string
  version: string
  dev: boolean
}

export interface SiteModuleDependencyUsage {
  name: string
  version: string
  dev: boolean
  modules: string[]
  moduleIds: string[]
  placements: number
}

interface ModuleDependencySite {
  pages: ReadonlyArray<{ nodes: Record<string, BaseNode> }>
  visualComponents: ReadonlyArray<{ tree: { nodes: Record<string, BaseNode> } }>
}

export function normalizeModuleDependencies(
  dependencies: ModuleDependencies | undefined,
): NormalizedModuleDependency[] {
  return Object.entries(dependencies ?? {}).map(([rawName, spec]) => {
    const name = rawName.trim()
    if (!isSafePackageName(name)) {
      throw new Error(`[module dependencies] Invalid package name "${rawName}"`)
    }

    const version = typeof spec === 'string' ? spec.trim() : spec.version.trim()
    if (!version) {
      throw new Error(`[module dependencies] "${name}" must declare a non-empty version`)
    }

    return {
      name,
      version,
      dev: typeof spec === 'string' ? false : Boolean(spec.dev),
    }
  })
}

export function getSiteDependencyVersion(
  packageJson: SitePackageJson,
  dependency: Pick<NormalizedModuleDependency, 'name' | 'dev'>,
): string | null {
  const declared = readDeclaredDependency(packageJson, dependency.name)
  // A module's dev-declared dependency is satisfied by either bucket; a
  // runtime one only by `dependencies`, since dev packages are never resolved.
  if (!declared || (!dependency.dev && declared.dev)) return null
  return declared.range
}

export function getMissingModuleDependencies(
  moduleDefinition: AnyModuleDefinition,
  packageJson: SitePackageJson,
): NormalizedModuleDependency[] {
  const dependencies = normalizeModuleDependencies(moduleDefinition.dependencies)
  return dependencies.filter(
    (dependency) => getSiteDependencyVersion(packageJson, dependency) === null,
  )
}

export function getSiteModuleDependencyUsage(
  site: ModuleDependencySite | null | undefined,
  registry: IModuleRegistry,
): Map<string, SiteModuleDependencyUsage> {
  const usage = new Map<string, SiteModuleDependencyUsage>()
  if (!site) return usage

  const recordModule = (moduleId: string) => {
    const definition = registry.get(moduleId)
    if (!definition) return

    for (const dependency of normalizeModuleDependencies(definition.dependencies)) {
      const current = usage.get(dependency.name)
      if (current) {
        current.placements += 1
        if (!current.moduleIds.includes(definition.id)) {
          current.moduleIds.push(definition.id)
        }
        if (!current.modules.includes(definition.name)) {
          current.modules.push(definition.name)
        }
        continue
      }

      usage.set(dependency.name, {
        name: dependency.name,
        version: dependency.version,
        dev: dependency.dev,
        modules: [definition.name],
        moduleIds: [definition.id],
        placements: 1,
      })
    }
  }

  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      recordModule(node.moduleId)
    }
  }

  for (const component of site.visualComponents) {
    for (const node of Object.values(component.tree.nodes)) {
      recordModule(node.moduleId)
    }
  }

  return usage
}
