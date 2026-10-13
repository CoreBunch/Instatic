import { selectVisualComponentById, type BaseNode, type Page, type SiteDocument } from '@core/page-tree'
import { instantiateVCAtRef, parseVirtualVCPageId, resolveSlotName, safePropOverrides } from '@core/visualComponents'
import { extractRuntimeImportSpecifiers, type SiteScriptFormat } from '@core/site-runtime'
import { isSafePath, normalizePath } from '@core/files/pathValidation'

export interface StyleRuleScriptSource {
  fileId: string
  format: SiteScriptFormat
}

/**
 * Shared publisher/canvas usage analysis. The caller supplies its real script
 * selection; this walker does not invent a manifest or decide execution scope.
 */
export function collectPageStyleRuleIds(
  site: SiteDocument,
  page: Page,
  scripts: ReadonlyArray<StyleRuleScriptSource> = [],
): Set<string> {
  const usedIds = new Set<string>()
  const virtualComponentId = parseVirtualVCPageId(page.id)
  const virtualComponent = virtualComponentId ? selectVisualComponentById(site, virtualComponentId) : null
  for (const id of virtualComponent?.classIds ?? []) usedIds.add(id)
  const walk = (nodes: Record<string, BaseNode>, rootId: string, componentStack: ReadonlySet<string>): void => {
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id)) return
      visited.add(id)
      const node = nodes[id]
      if (!node || node.hidden) return
      for (const classId of node.classIds ?? []) usedIds.add(classId)

      if (node.moduleId === 'base.visual-component-ref') {
        const componentId = typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
        if (!componentId || componentStack.has(componentId)) return
        const component = selectVisualComponentById(site, componentId)
        if (!component) return
        for (const classId of component.classIds ?? []) usedIds.add(classId)
        const slots: Record<string, string[]> = {}
        for (const childId of node.children) {
          const child = nodes[childId]
          if (child?.moduleId === 'base.slot-instance') slots[resolveSlotName(child.props)] = child.children
        }
        const instance = instantiateVCAtRef(component, safePropOverrides(node.props), slots, nodes, node.id)
        walk(instance.nodes, instance.rootNodeId, new Set(componentStack).add(componentId))
        return
      }
      for (const childId of node.children) visit(childId)
    }
    visit(rootId)
  }
  walk(page.nodes, page.rootNodeId, new Set())

  // Scan only selected entry sources and their reachable local module helpers.
  const scriptFiles = (site.files ?? []).filter((file) => file.type === 'script')
  const byId = new Map(scriptFiles.map((file) => [file.id, file]))
  const byPath = new Map(scriptFiles.map((file) => [normalizePath(file.path), file]))
  const visitedFiles = new Set<string>()
  const visitedImports = new Set<string>()
  const runs = new Set<string>()
  const visitScript = (fileId: string, includeImports: boolean): void => {
    const file = byId.get(fileId)
    if (!file || typeof file.content !== 'string') return
    if (!visitedFiles.has(fileId)) {
      visitedFiles.add(fileId)
      for (const run of file.content.split(/[^A-Za-z0-9_-]+/)) if (run) runs.add(run)
      // Quoted class names may contain CSS punctuation (e.g. hover:block or
      // group/name) or Unicode. Keep complete source tokens as well as runs.
      for (const token of file.content.split(/[\s"'`()[\]{};,=]+/)) if (token) runs.add(token)
    }
    if (!includeImports || visitedImports.has(fileId)) return
    visitedImports.add(fileId)
    for (const entry of extractRuntimeImportSpecifiers(file.content)) {
      const path = resolveLocalScriptPath(file.path, entry.specifier)
      if (!path) continue
      const imported = scriptPathCandidates(path).map((candidate) => byPath.get(candidate)).find(Boolean)
      if (imported) visitScript(imported.id, true)
    }
  }
  for (const script of scripts) visitScript(script.fileId, script.format === 'module')
  for (const rule of Object.values(site.styleRules ?? {})) {
    if (rule.kind === 'class' && runs.has(rule.name)) usedIds.add(rule.id)
  }
  return usedIds
}

function resolveLocalScriptPath(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  const parts = normalizePath(importer).split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (segment === '.' || !segment) continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(segment)
  }
  const path = parts.join('/')
  return isSafePath(path) ? path : null
}

function scriptPathCandidates(path: string): string[] {
  const extensions = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts']
  // TS imports commonly spell the eventual .js filename while the authored
  // workspace carries .ts/.tsx. Include directory index and extensionless imports.
  const typed = path.endsWith('.mjs') ? [path.slice(0, -4) + '.mts']
    : path.endsWith('.cjs') ? [path.slice(0, -4) + '.cts']
      : path.endsWith('.js') ? [path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx'] : []
  return [path, ...typed, ...extensions.map((extension) => path + extension), ...extensions.map((extension) => `${path}/index${extension}`)]
}
