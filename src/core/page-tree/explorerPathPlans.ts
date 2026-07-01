import { isSafePath, normalizePath } from '@core/files/pathValidation'
import type { SiteFile } from '@core/files/schemas'
import {
  extractRuntimeImportSpecifiers,
} from '@core/site-runtime'
import type { SiteRuntimeConfig } from '@core/site-runtime-schema'
import type { SiteDocument } from './siteDocument'
import type { StructuralExplorerSection, StructuralSiteExplorerSectionId } from './siteExplorer'
import { isHomePage, pageSlugError } from './slugs'

interface ExplorerPathChangeBlocker {
  code:
    | 'duplicate-page-slug'
    | 'invalid-page-slug'
    | 'duplicate-file-path'
    | 'unsafe-file-path'
    | 'homepage-protected'
    | 'hidden-generated-file'
    | 'folder-cycle'
  message: string
  target: string
}

interface ExplorerPathChangeWarning {
  code: 'raw-url-not-rewritten' | 'relative-script-import'
  message: string
  sourcePath?: string
}

interface ExplorerPathRewriteChange {
  id: string
  label: string
  from: string
  to: string
}

interface ExplorerPathDeletedItem {
  id: string
  label: string
  path: string
}

/** A structural folder that moves as a whole (rename or reparent). Drives the
 *  bookkeeping rewrite so empty folders — which have no page/file rows — still
 *  follow their new path across emptyFolders/expandedFolders/rowOrder. */
interface ExplorerFolderPathChange {
  from: string
  to: string
}

interface ExplorerPathRewritePlan {
  kind: 'rewrite'
  sectionId: StructuralSiteExplorerSectionId
  operationLabel: string
  changes: ExplorerPathRewriteChange[]
  blockers: ExplorerPathChangeBlocker[]
  warnings: ExplorerPathChangeWarning[]
  /** Set for folder rename/move; absent for single-item moves. */
  folderPathChange?: ExplorerFolderPathChange
}

interface ExplorerPathDeletePlan {
  kind: 'delete'
  sectionId: StructuralSiteExplorerSectionId
  operationLabel: string
  deletedItems: ExplorerPathDeletedItem[]
  blockers: ExplorerPathChangeBlocker[]
  warnings: ExplorerPathChangeWarning[]
  /** The folder subtree being removed, including empty folders with no rows. */
  folderPath: string
}

export type ExplorerPathChangePlan = ExplorerPathRewritePlan | ExplorerPathDeletePlan

interface StructuralItem {
  id: string
  label: string
  path: string
  file?: SiteFile
}

export function buildRenameExplorerFolderPlan(
  site: SiteDocument,
  input: { sectionId: StructuralSiteExplorerSectionId; folderPath: string; nextFolderPath: string },
): ExplorerPathRewritePlan {
  const changes = structuralItems(site, input.sectionId)
    .filter((item) => isDescendantPath(item.path, input.folderPath))
    .map((item) => ({
      id: item.id,
      label: item.label,
      from: item.path,
      to: replacePathPrefix(item.path, input.folderPath, input.nextFolderPath),
    }))

  return rewritePlan(
    site,
    input.sectionId,
    `Rename ${input.folderPath} to ${input.nextFolderPath}`,
    changes,
    { from: input.folderPath, to: input.nextFolderPath },
  )
}

export function buildMoveExplorerFolderPlan(
  site: SiteDocument,
  input: { sectionId: StructuralSiteExplorerSectionId; folderPath: string; nextParentPath: string | undefined },
): ExplorerPathRewritePlan {
  const nextFolderPath = joinPath(input.nextParentPath, basename(input.folderPath))
  const changes = structuralItems(site, input.sectionId)
    .filter((item) => isDescendantPath(item.path, input.folderPath))
    .map((item) => ({
      id: item.id,
      label: item.label,
      from: item.path,
      to: replacePathPrefix(item.path, input.folderPath, nextFolderPath),
    }))
  const plan = rewritePlan(
    site,
    input.sectionId,
    `Move ${input.folderPath} to ${nextFolderPath}`,
    changes,
    { from: input.folderPath, to: nextFolderPath },
  )

  if (input.nextParentPath && isDescendantPath(input.nextParentPath, input.folderPath)) {
    plan.blockers.push({
      code: 'folder-cycle',
      message: `Folder "${input.folderPath}" cannot be moved into itself.`,
      target: input.nextParentPath,
    })
  }

  return plan
}

export function buildMoveExplorerItemPlan(
  site: SiteDocument,
  input: { sectionId: StructuralSiteExplorerSectionId; itemId: string; nextParentPath: string | undefined },
): ExplorerPathRewritePlan {
  const item = structuralItems(site, input.sectionId).find((candidate) => candidate.id === input.itemId)
  const changes = item
    ? [{ id: item.id, label: item.label, from: item.path, to: joinPath(input.nextParentPath, basename(item.path)) }]
    : []
  return rewritePlan(
    site,
    input.sectionId,
    item && changes[0] ? `Move ${item.path} to ${changes[0].to}` : 'Move item',
    changes,
  )
}

export function buildDeleteExplorerPathPlan(
  site: SiteDocument,
  input: { sectionId: StructuralSiteExplorerSectionId; folderPath: string },
): ExplorerPathDeletePlan {
  const deletedItems = structuralItems(site, input.sectionId)
    .filter((item) => isDescendantPath(item.path, input.folderPath))
    .map((item) => ({ id: item.id, label: item.label, path: item.path }))
  const blockers = blockersForDelete(site, input.sectionId, input.folderPath, deletedItems)

  return {
    kind: 'delete',
    sectionId: input.sectionId,
    operationLabel: `Delete ${input.folderPath}`,
    deletedItems,
    blockers,
    warnings: [{ code: 'raw-url-not-rewritten', message: 'Raw URLs in authored content are not rewritten.' }],
    folderPath: input.folderPath,
  }
}

export function commitExplorerPathPlan(
  site: SiteDocument,
  liveRuntime: SiteRuntimeConfig | undefined,
  plan: ExplorerPathChangePlan,
): void {
  if (plan.blockers.length > 0) {
    throw new Error('[SiteExplorer] Cannot commit a blocked path change plan')
  }

  if (plan.kind === 'rewrite') {
    commitRewritePlan(site, plan)
    return
  }

  commitDeletePlan(site, liveRuntime, plan)
}

function rewritePlan(
  site: SiteDocument,
  sectionId: StructuralSiteExplorerSectionId,
  operationLabel: string,
  changes: ExplorerPathRewriteChange[],
  folderPathChange?: ExplorerFolderPathChange,
): ExplorerPathRewritePlan {
  return {
    kind: 'rewrite',
    sectionId,
    operationLabel,
    changes,
    blockers: blockersForRewrite(site, sectionId, changes),
    warnings: warningsForRewrite(site, sectionId, changes),
    ...(folderPathChange && folderPathChange.from !== folderPathChange.to
      ? { folderPathChange }
      : {}),
  }
}

function blockersForRewrite(
  site: SiteDocument,
  sectionId: StructuralSiteExplorerSectionId,
  changes: ExplorerPathRewriteChange[],
): ExplorerPathChangeBlocker[] {
  const blockers: ExplorerPathChangeBlocker[] = []
  const changedIds = new Set(changes.map((change) => change.id))
  const targets = new Set<string>()
  for (const change of changes) {
    if (targets.has(change.to)) {
      blockers.push({
        code: sectionId === 'pages' ? 'duplicate-page-slug' : 'duplicate-file-path',
        message: `Duplicate target "${change.to}".`,
        target: change.to,
      })
    }
    targets.add(change.to)

    if (sectionId === 'pages') {
      addPageRewriteBlockers(site, change, changedIds, blockers)
    } else {
      addFileRewriteBlockers(site, change, changedIds, blockers)
    }
  }
  return blockers
}

function addPageRewriteBlockers(
  site: SiteDocument,
  change: ExplorerPathRewriteChange,
  changedIds: ReadonlySet<string>,
  blockers: ExplorerPathChangeBlocker[],
): void {
  const error = pageSlugError(change.to)
  if (error) {
    blockers.push({ code: 'invalid-page-slug', message: error, target: change.to })
  }

  const page = site.pages.find((candidate) => candidate.id === change.id)
  if (page && isHomePage(page)) {
    blockers.push({
      code: 'homepage-protected',
      message: 'The homepage cannot be moved by folder operations.',
      target: change.from,
    })
  }

  if (site.pages.some((candidate) =>
    candidate.id !== change.id
    && !changedIds.has(candidate.id)
    && candidate.slug === change.to
  )) {
    blockers.push({
      code: 'duplicate-page-slug',
      message: `Page slug "/${change.to}" already exists.`,
      target: change.to,
    })
  }
}

function addFileRewriteBlockers(
  site: SiteDocument,
  change: ExplorerPathRewriteChange,
  changedIds: ReadonlySet<string>,
  blockers: ExplorerPathChangeBlocker[],
): void {
  const normalized = normalizePath(change.to)
  if (!isSafePath(normalized) || normalized !== change.to) {
    blockers.push({
      code: 'unsafe-file-path',
      message: `File path "${change.to}" is not safe.`,
      target: change.to,
    })
  }

  if (site.files.some((candidate) =>
    candidate.id !== change.id
    && !changedIds.has(candidate.id)
    && candidate.path === change.to
  )) {
    blockers.push({
      code: 'duplicate-file-path',
      message: `File path "${change.to}" already exists.`,
      target: change.to,
    })
  }
}

function blockersForDelete(
  site: SiteDocument,
  sectionId: StructuralSiteExplorerSectionId,
  folderPath: string,
  deletedItems: readonly ExplorerPathDeletedItem[],
): ExplorerPathChangeBlocker[] {
  const blockers: ExplorerPathChangeBlocker[] = []
  if (sectionId === 'pages' && deletedItems.some((item) => item.path === 'index')) {
    blockers.push({
      code: 'homepage-protected',
      message: 'The homepage cannot be deleted by folder operations.',
      target: 'index',
    })
  }
  if (sectionId !== 'pages') {
    for (const file of hiddenGeneratedFiles(site, sectionId, folderPath)) {
      blockers.push({
        code: 'hidden-generated-file',
        message: `Generated file "${file.path}" cannot be deleted from the explorer.`,
        target: file.path,
      })
    }
  }
  return blockers
}

function warningsForRewrite(
  site: SiteDocument,
  sectionId: StructuralSiteExplorerSectionId,
  changes: readonly ExplorerPathRewriteChange[],
): ExplorerPathChangeWarning[] {
  const warnings: ExplorerPathChangeWarning[] = []
  if (sectionId === 'scripts') {
    const changedIds = new Set(changes.map((change) => change.id))
    for (const file of site.files) {
      if (file.type !== 'script' || !changedIds.has(file.id) || typeof file.content !== 'string') continue
      const relativeImports = extractRuntimeImportSpecifiers(file.content)
        .filter((entry) => entry.specifier.startsWith('.'))
      if (relativeImports.length === 0) continue
      warnings.push({
        code: 'relative-script-import',
        sourcePath: file.path,
        message: `Moving "${file.path}" can affect relative imports: ${
          relativeImports.map((entry) => entry.specifier).join(', ')
        }`,
      })
    }
  }

  warnings.push({ code: 'raw-url-not-rewritten', message: 'Raw URLs in authored content are not rewritten.' })
  return warnings
}

function commitRewritePlan(site: SiteDocument, plan: ExplorerPathRewritePlan): void {
  const now = Date.now()
  for (const change of plan.changes) {
    if (plan.sectionId === 'pages') {
      const page = site.pages.find((candidate) => candidate.id === change.id)
      if (page) page.slug = change.to
    } else {
      const file = site.files.find((candidate) => candidate.id === change.id)
      if (file) {
        file.path = change.to
        file.updatedAt = now
      }
    }
  }

  // Empty folders have no page/file rows, so their new path is only reflected in
  // the section bookkeeping. Non-empty folder renames route through here too,
  // which keeps their expansion + ordering intact instead of losing it to the
  // stale-entry pruning in reconcileSiteExplorerInPlace.
  if (plan.folderPathChange) {
    rewriteStructuralFolderPaths(site.explorer[plan.sectionId], plan.folderPathChange.from, plan.folderPathChange.to)
  }

  if (plan.changes.length > 0 || plan.folderPathChange) site.updatedAt = now
}

function commitDeletePlan(
  site: SiteDocument,
  liveRuntime: SiteRuntimeConfig | undefined,
  plan: ExplorerPathDeletePlan,
): void {
  const deletedIds = new Set(plan.deletedItems.map((item) => item.id))

  if (deletedIds.size > 0) {
    if (plan.sectionId === 'pages') {
      site.pages = site.pages.filter((page) => !deletedIds.has(page.id))
    } else {
      site.files = site.files.filter((file) => !deletedIds.has(file.id))
      for (const id of deletedIds) {
        if (plan.sectionId === 'scripts') {
          if (site.runtime?.scripts) delete site.runtime.scripts[id]
          if (liveRuntime?.scripts) delete liveRuntime.scripts[id]
        } else {
          if (site.runtime?.styles) delete site.runtime.styles[id]
          if (liveRuntime?.styles) delete liveRuntime.styles[id]
        }
      }
    }
  }

  // Remove the folder subtree from the section bookkeeping. Empty folders live
  // only here, so without this an empty-folder delete would leave the folder
  // standing after commit.
  const removed = removeStructuralFolderPaths(site.explorer[plan.sectionId], plan.folderPath)

  if (deletedIds.size > 0 || removed) site.updatedAt = Date.now()
}

/** Move every bookkeeping reference to `from` (and its descendants) onto `to`. */
function rewriteStructuralFolderPaths(section: StructuralExplorerSection, from: string, to: string): void {
  section.emptyFolders = dedupePaths(section.emptyFolders.map((path) => rewriteFolderPath(path, from, to)))
  section.expandedFolders = dedupePaths(section.expandedFolders.map((path) => rewriteFolderPath(path, from, to)))
  section.rowOrder = section.rowOrder.map((entry) => ({
    ...entry,
    ...(entry.kind === 'folder' ? { id: rewriteFolderPath(entry.id, from, to) } : {}),
    ...(entry.parentPath !== undefined ? { parentPath: rewriteFolderPath(entry.parentPath, from, to) } : {}),
  }))
}

/** Drop every bookkeeping reference at or under `folderPath`. Returns whether anything changed. */
function removeStructuralFolderPaths(section: StructuralExplorerSection, folderPath: string): boolean {
  const emptyFolders = section.emptyFolders.filter((path) => !isDescendantPath(path, folderPath))
  const expandedFolders = section.expandedFolders.filter((path) => !isDescendantPath(path, folderPath))
  const rowOrder = section.rowOrder.filter(
    (entry) => !(entry.kind === 'folder' && isDescendantPath(entry.id, folderPath)),
  )
  const changed =
    emptyFolders.length !== section.emptyFolders.length
    || expandedFolders.length !== section.expandedFolders.length
    || rowOrder.length !== section.rowOrder.length
  section.emptyFolders = emptyFolders
  section.expandedFolders = expandedFolders
  section.rowOrder = rowOrder
  return changed
}

function rewriteFolderPath(path: string, from: string, to: string): string {
  if (path === from) return to
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
  return path
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

function structuralItems(site: SiteDocument, sectionId: StructuralSiteExplorerSectionId): StructuralItem[] {
  if (sectionId === 'pages') {
    return site.pages
      .filter((page) => !page.template)
      .map((page) => ({ id: page.id, label: page.title, path: page.slug }))
  }

  const type = sectionId === 'styles' ? 'style' : 'script'
  return site.files
    .filter((file) => file.type === type && (!file.generated || file.ejected))
    .map((file) => ({
      id: file.id,
      label: basename(file.path),
      path: file.path,
      file,
    }))
}

function hiddenGeneratedFiles(
  site: SiteDocument,
  sectionId: StructuralSiteExplorerSectionId,
  folderPath: string,
): SiteFile[] {
  const type = sectionId === 'styles' ? 'style' : 'script'
  return site.files.filter((file) =>
    file.type === type
    && file.generated
    && !file.ejected
    && isDescendantPath(file.path, folderPath)
  )
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function joinPath(parentPath: string | undefined, leaf: string): string {
  return parentPath ? `${parentPath}/${leaf}` : leaf
}

function isDescendantPath(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`)
}

function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (path === fromPrefix) return toPrefix
  return `${toPrefix}${path.slice(fromPrefix.length)}`
}
