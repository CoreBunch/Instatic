/**
 * Pure helpers that turn runtime-script analysis into what the Dependencies
 * panel shows: per-package usage ("in use by …") and actionable issues
 * (missing package, dev-only package, node built-in, invalid name).
 */
import type { SiteModuleDependencyUsage } from '@core/module-engine'
import type { RuntimePackageDependencyUsage, SiteRuntimeDiagnostic } from '@core/site-runtime'

export interface DependencyUsageSummary {
  moduleUsage?: SiteModuleDependencyUsage
  scriptUsage?: RuntimePackageDependencyUsage
}

export interface RuntimeDependencyIssue {
  code: string
  packageName: string
  message: string
  action: 'add' | 'move-to-runtime' | null
}

export function combineDependencyUsage(
  moduleUsage: Map<string, SiteModuleDependencyUsage>,
  scriptUsage: Map<string, RuntimePackageDependencyUsage>,
): Map<string, DependencyUsageSummary> {
  const combined = new Map<string, DependencyUsageSummary>()
  for (const [name, usage] of moduleUsage) combined.set(name, { moduleUsage: usage })
  for (const [name, usage] of scriptUsage) combined.set(name, { ...combined.get(name), scriptUsage: usage })
  return combined
}

function formatModuleUsage(usage: SiteModuleDependencyUsage): string {
  if (usage.modules.length <= 2) return usage.modules.join(', ')
  return `${usage.modules.slice(0, 2).join(', ')} +${usage.modules.length - 2}`
}

function formatScriptUsage(usage: RuntimePackageDependencyUsage): string {
  const paths = usage.files.map((file) => file.path.split('/').pop() ?? file.path)
  if (paths.length <= 2) return paths.join(', ')
  return `${paths.slice(0, 2).join(', ')} +${paths.length - 2}`
}

export function formatDependencyUsage(usage: DependencyUsageSummary): string {
  const parts: string[] = []
  if (usage.moduleUsage) parts.push(formatModuleUsage(usage.moduleUsage))
  if (usage.scriptUsage) parts.push(`scripts: ${formatScriptUsage(usage.scriptUsage)}`)
  return parts.join('; ')
}

const ISSUE_MESSAGES: Record<string, { message: string; action: RuntimeDependencyIssue['action'] }> = {
  'runtime-dependency-missing': { message: 'missing from dependencies', action: 'add' },
  'runtime-dependency-dev-only': { message: 'declared as devDependency', action: 'move-to-runtime' },
  'runtime-dependency-node-builtin': { message: 'not available in browser runtime', action: null },
  'runtime-dependency-invalid-name': { message: 'has an invalid package name', action: null },
}

export function summarizeRuntimeDependencyIssues(diagnostics: SiteRuntimeDiagnostic[]): RuntimeDependencyIssue[] {
  const issues = new Map<string, RuntimeDependencyIssue>()
  for (const diagnostic of diagnostics) {
    if (!diagnostic.packageName) continue
    const known = ISSUE_MESSAGES[diagnostic.code]
    if (!known) continue
    const key = `${diagnostic.code}:${diagnostic.packageName}`
    if (issues.has(key)) continue
    issues.set(key, { code: diagnostic.code, packageName: diagnostic.packageName, ...known })
  }
  return [...issues.values()]
}
