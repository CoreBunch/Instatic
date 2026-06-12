import { nanoid } from 'nanoid'
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import { compiledCheck, compiledDecode } from '@core/utils/typeboxCompiler'
import type { SiteFile } from '@core/files/schemas'
import type { Page } from './page'
import type { SiteDocument } from './siteDocument'
import type { VisualComponent } from '@core/visualComponents'
import { isHomePage } from './slugs'
import { addFolderPrefixes, parentPathForPath } from './explorerPaths'

export const SITE_EXPLORER_SECTION_IDS = [
  'pages',
  'templates',
  'components',
  'styles',
  'scripts',
] as const

export type StructuralSiteExplorerSectionId = 'pages' | 'styles' | 'scripts'
export type DecorativeSiteExplorerSectionId = 'templates' | 'components'
export type SiteExplorerSectionId = (typeof SITE_EXPLORER_SECTION_IDS)[number]

const SiteExplorerFolderSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  order: Type.Number({ default: 0 }),
})

const SiteExplorerItemPlacementSchema = Type.Object({
  id: Type.String(),
  parentFolderId: Type.Optional(Type.String()),
  order: Type.Number(),
})

const StructuralExplorerRowOrderSchema = Type.Object({
  kind: Type.Union([Type.Literal('folder'), Type.Literal('item')]),
  id: Type.String(),
  parentPath: Type.Optional(Type.String()),
  order: Type.Number(),
})

const StructuralExplorerSectionSchema = Type.Object({
  expandedFolders: Type.Array(Type.String()),
  emptyFolders: Type.Array(Type.String()),
  rowOrder: Type.Array(StructuralExplorerRowOrderSchema),
})

const DecorativeExplorerSectionSchema = Type.Object({
  folders: Type.Array(SiteExplorerFolderSchema),
  items: Type.Array(SiteExplorerItemPlacementSchema),
})

export const SiteExplorerOrganizationSchema = Type.Object({
  pages: StructuralExplorerSectionSchema,
  styles: StructuralExplorerSectionSchema,
  scripts: StructuralExplorerSectionSchema,
  templates: DecorativeExplorerSectionSchema,
  components: DecorativeExplorerSectionSchema,
})

export type SiteExplorerFolder = Static<typeof SiteExplorerFolderSchema>
export type SiteExplorerItemPlacement = Static<typeof SiteExplorerItemPlacementSchema>
export type StructuralExplorerRowOrder = Static<typeof StructuralExplorerRowOrderSchema>
export type StructuralExplorerSection = Static<typeof StructuralExplorerSectionSchema>
type DecorativeExplorerSection = Static<typeof DecorativeExplorerSectionSchema>
export type SiteExplorerOrganization = Static<typeof SiteExplorerOrganizationSchema>

type SiteExplorerRootEntry =
  | { kind: 'folder'; folder: SiteExplorerFolder; order: number }
  | { kind: 'item'; item: SiteExplorerItemPlacement; order: number }

interface SiteExplorerSources {
  pages: readonly Page[]
  visualComponents: readonly VisualComponent[]
  files: readonly SiteFile[]
}

export function createDefaultSiteExplorerOrganization(): SiteExplorerOrganization {
  return {
    pages: createEmptyStructuralSection(),
    styles: createEmptyStructuralSection(),
    scripts: createEmptyStructuralSection(),
    templates: createEmptyDecorativeSection(),
    components: createEmptyDecorativeSection(),
  }
}

function createEmptyStructuralSection(): StructuralExplorerSection {
  return { expandedFolders: [], emptyFolders: [], rowOrder: [] }
}

function createEmptyDecorativeSection(): DecorativeExplorerSection {
  return { folders: [], items: [] }
}

export function parseSiteExplorerOrganization(raw: unknown): SiteExplorerOrganization {
  const parsed = createDefaultSiteExplorerOrganization()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return parsed
  const record = raw as Record<string, unknown>

  parsed.pages = parseStructuralSection(record.pages)
  parsed.styles = parseStructuralSection(record.styles)
  parsed.scripts = parseStructuralSection(record.scripts)
  parsed.templates = parseDecorativeSection(record.templates)
  parsed.components = parseDecorativeSection(record.components)

  return parsed
}

function parseStructuralSection(raw: unknown): StructuralExplorerSection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createEmptyStructuralSection()
  const record = raw as Record<string, unknown>
  const expandedFolders = parseFolderPaths(record.expandedFolders)
  const expandedSet = new Set(expandedFolders)
  const emptyFolders = parseFolderPaths(record.emptyFolders)
    .filter((path) => !expandedSet.has(path))
  const rowOrder = parseStructuralRowOrder(record.rowOrder)
  return { expandedFolders, emptyFolders, rowOrder }
}

function parseDecorativeSection(raw: unknown): DecorativeExplorerSection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createEmptyDecorativeSection()
  const record = raw as Record<string, unknown>
  const folders = parseFolders(record.folders)
  const folderIds = new Set(folders.map((folder) => folder.id))
  const items = parseItems(record.items, folderIds)
  return normalizeSection({ folders, items })
}

function parseFolderPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const paths: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const path = normalizeExplorerPath(value)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

function parseStructuralRowOrder(raw: unknown): StructuralExplorerRowOrder[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const rowOrder: StructuralExplorerRowOrder[] = []
  for (const entry of raw) {
    if (!compiledCheck(StructuralExplorerRowOrderSchema, entry)) continue
    const item = compiledDecode(StructuralExplorerRowOrderSchema, entry)
    const id = normalizeExplorerPath(item.id)
    const parentPath = item.parentPath ? normalizeExplorerPath(item.parentPath) : undefined
    if (!id || !Number.isFinite(item.order)) continue
    const key = `${item.kind}:${parentPath ?? ''}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    rowOrder.push({
      kind: item.kind,
      id,
      ...(parentPath ? { parentPath } : {}),
      order: item.order,
    })
  }
  return rowOrder
}

function normalizeExplorerPath(value: string): string | null {
  const path = value.trim().replace(/^\/+|\/+$/g, '')
  if (!path || path.includes('\\')) return null
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

function parseFolders(raw: unknown): SiteExplorerFolder[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const folders: SiteExplorerFolder[] = []
  for (const entry of raw) {
    let folder: SiteExplorerFolder
    try {
      folder = Value.Parse(SiteExplorerFolderSchema, entry) as SiteExplorerFolder
    } catch {
      continue
    }
    const id = folder.id.trim()
    if (!id || seen.has(id) || !Number.isFinite(folder.order)) continue
    seen.add(id)
    folders.push({ id, name: folder.name.trim() || 'Folder', order: folder.order })
  }
  return folders
}

function parseItems(raw: unknown, folderIds: ReadonlySet<string>): SiteExplorerItemPlacement[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const items: SiteExplorerItemPlacement[] = []
  for (const entry of raw) {
    if (!compiledCheck(SiteExplorerItemPlacementSchema, entry)) continue
    const item = compiledDecode(SiteExplorerItemPlacementSchema, entry)
    const id = item.id.trim()
    if (!id || seen.has(id) || !Number.isFinite(item.order)) continue
    seen.add(id)
    const parentFolderId = item.parentFolderId?.trim()
    items.push({
      id,
      ...(parentFolderId && folderIds.has(parentFolderId) ? { parentFolderId } : {}),
      order: item.order,
    })
  }
  return items
}

export function reconcileSiteExplorerOrganization(
  organization: SiteExplorerOrganization | undefined,
  sources: SiteExplorerSources,
): SiteExplorerOrganization {
  const base = parseSiteExplorerOrganization(organization)

  return {
    pages: reconcileStructuralSection(base.pages, structuralRowsForPages(sources.pages)),
    styles: reconcileStructuralSection(base.styles, structuralRowsForFiles(sources.files, 'style')),
    scripts: reconcileStructuralSection(base.scripts, structuralRowsForFiles(sources.files, 'script')),
    templates: reconcileSection(base.templates, pageIds(sources.pages, true)),
    components: reconcileSection(base.components, sources.visualComponents.map((component) => component.id)),
  }
}

function pageIds(pages: readonly Page[], templates: boolean): string[] {
  return pages
    .filter((page) => Boolean(page.template) === templates)
    .map((page) => page.id)
}

interface StructuralRows {
  folders: ReadonlySet<string>
  items: ReadonlyMap<string, string | undefined>
  itemPaths: ReadonlySet<string>
}

function structuralRowsForPages(pages: readonly Page[]): StructuralRows {
  const folders = new Set<string>()
  const items = new Map<string, string | undefined>()
  const itemPaths = new Set<string>()
  for (const page of pages) {
    if (page.template || isHomePage(page)) continue
    itemPaths.add(page.slug)
    items.set(page.id, parentPathForPath(page.slug))
    addFolderPrefixes(folders, page.slug)
  }
  return { folders, items, itemPaths }
}

function structuralRowsForFiles(files: readonly SiteFile[], type: 'style' | 'script'): StructuralRows {
  const folders = new Set<string>()
  const items = new Map<string, string | undefined>()
  const itemPaths = new Set<string>()
  for (const file of files) {
    if (file.type !== type || (file.generated && !file.ejected)) continue
    itemPaths.add(file.path)
    items.set(file.id, parentPathForPath(file.path))
    addFolderPrefixes(folders, file.path)
  }
  return { folders, items, itemPaths }
}

function reconcileStructuralSection(
  section: StructuralExplorerSection,
  rows: StructuralRows,
): StructuralExplorerSection {
  const keptEmptyFolders = section.emptyFolders.filter((path) =>
    !rows.folders.has(path) && !rows.itemPaths.has(path)
  )
  const keptEmptyFolderSet = new Set(keptEmptyFolders)
  return {
    expandedFolders: section.expandedFolders.filter((path) =>
      rows.folders.has(path) || keptEmptyFolderSet.has(path)
    ),
    emptyFolders: keptEmptyFolders,
    rowOrder: section.rowOrder.filter((entry) => {
      if (entry.kind === 'folder') {
        return (rows.folders.has(entry.id) || keptEmptyFolderSet.has(entry.id))
          && parentPathForPath(entry.id) === entry.parentPath
      }
      return rows.items.has(entry.id) && rows.items.get(entry.id) === entry.parentPath
    }),
  }
}

function reconcileSection(section: DecorativeExplorerSection, sourceIds: readonly string[]): DecorativeExplorerSection {
  const sourceSet = new Set(sourceIds)
  const folderIds = new Set(section.folders.map((folder) => folder.id))
  const seen = new Set<string>()
  const items: SiteExplorerItemPlacement[] = []

  for (const item of sortItems(section.items)) {
    if (!sourceSet.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    const parentFolderId = item.parentFolderId && folderIds.has(item.parentFolderId)
      ? item.parentFolderId
      : undefined
    items.push({
      id: item.id,
      ...(parentFolderId ? { parentFolderId } : {}),
      order: item.order,
    })
  }

  const reconciled = normalizeSection({ folders: section.folders, items })
  for (const id of sourceIds) {
    if (seen.has(id)) continue
    seen.add(id)
    reconciled.items.push({ id, order: nextRootOrder(reconciled) })
    normalizeSectionInPlace(reconciled)
  }

  return reconciled
}

export function createExplorerFolder(
  organization: SiteExplorerOrganization,
  sectionId: DecorativeSiteExplorerSectionId,
  name: string,
): string {
  const id = nanoid()
  const section = organization[sectionId]
  section.folders.push({ id, name: name.trim() || 'Folder', order: nextRootOrder(section) })
  normalizeSectionInPlace(section)
  return id
}

export function renameExplorerFolder(
  organization: SiteExplorerOrganization,
  sectionId: DecorativeSiteExplorerSectionId,
  folderId: string,
  name: string,
): void {
  const folder = organization[sectionId].folders.find((candidate) => candidate.id === folderId)
  if (!folder) return
  folder.name = name.trim() || 'Folder'
}

export function deleteExplorerFolder(
  organization: SiteExplorerOrganization,
  sectionId: DecorativeSiteExplorerSectionId,
  folderId: string,
): void {
  const section = organization[sectionId]
  const index = section.folders.findIndex((folder) => folder.id === folderId)
  if (index === -1) return
  section.folders.splice(index, 1)
  for (const item of section.items) {
    if (item.parentFolderId === folderId) delete item.parentFolderId
  }
  normalizeSectionInPlace(section)
}

export function moveExplorerFolder(
  organization: SiteExplorerOrganization,
  sectionId: DecorativeSiteExplorerSectionId,
  folderId: string,
  nextIndex: number,
): void {
  const section = organization[sectionId]
  normalizeSectionInPlace(section)
  const folder = section.folders.find((candidate) => candidate.id === folderId)
  if (!folder) return

  const rootEntries = rootEntriesForSection(section)
    .filter((entry) => entry.kind !== 'folder' || entry.folder.id !== folderId)
  rootEntries.splice(clampIndex(nextIndex, rootEntries.length), 0, {
    kind: 'folder',
    folder,
    order: folder.order,
  })
  applyRootEntryOrder(rootEntries)
  normalizeSectionInPlace(section)
}

export function moveExplorerItem(
  organization: SiteExplorerOrganization,
  sectionId: DecorativeSiteExplorerSectionId,
  itemId: string,
  parentFolderId: string | null,
  nextIndex: number,
): void {
  const section = organization[sectionId]
  normalizeSectionInPlace(section)
  const item = section.items.find((candidate) => candidate.id === itemId)
  if (!item) return
  const targetParentId = parentFolderId && section.folders.some((folder) => folder.id === parentFolderId)
    ? parentFolderId
    : undefined

  if (!targetParentId) {
    delete item.parentFolderId
    const rootEntries = rootEntriesForSection(section)
      .filter((entry) => entry.kind !== 'item' || entry.item.id !== itemId)
    rootEntries.splice(clampIndex(nextIndex, rootEntries.length), 0, {
      kind: 'item',
      item,
      order: item.order,
    })
    applyRootEntryOrder(rootEntries)
  } else {
    item.parentFolderId = targetParentId
    const siblings = section.items
      .filter((candidate) => candidate.id !== itemId && candidate.parentFolderId === targetParentId)
      .sort((a, b) => a.order - b.order)
    siblings.splice(clampIndex(nextIndex, siblings.length), 0, item)
    siblings.forEach((candidate, order) => {
      candidate.order = order
    })
  }
  normalizeSectionInPlace(section)
}

export function moveExplorerItems(
  organization: SiteExplorerOrganization,
  sectionId: DecorativeSiteExplorerSectionId,
  itemIds: readonly string[],
  parentFolderId: string | null,
  nextIndex: number,
): void {
  const section = organization[sectionId]
  normalizeSectionInPlace(section)
  const selectedIds = uniqueExistingItemIds(section, itemIds)
  if (selectedIds.length === 0) return

  const targetParentId = parentFolderId && section.folders.some((folder) => folder.id === parentFolderId)
    ? parentFolderId
    : undefined
  const selected = orderedSelectedItems(section, selectedIds)

  if (!targetParentId) {
    for (const item of selected) delete item.parentFolderId
    const selectedSet = new Set(selectedIds)
    const rootEntries = rootEntriesForSection(section)
      .filter((entry) => entry.kind !== 'item' || !selectedSet.has(entry.item.id))
    rootEntries.splice(
      clampIndex(nextIndex, rootEntries.length),
      0,
      ...selected.map((item) => ({
        kind: 'item' as const,
        item,
        order: item.order,
      })),
    )
    applyRootEntryOrder(rootEntries)
  } else {
    for (const item of selected) item.parentFolderId = targetParentId
    const selectedSet = new Set(selectedIds)
    const siblings = section.items
      .filter((candidate) => candidate.parentFolderId === targetParentId && !selectedSet.has(candidate.id))
      .sort((a, b) => a.order - b.order)
    siblings.splice(clampIndex(nextIndex, siblings.length), 0, ...selected)
    siblings.forEach((candidate, order) => {
      candidate.order = order
    })
  }

  normalizeSectionInPlace(section)
}

export function wrapExplorerItemsInFolder(
  organization: SiteExplorerOrganization,
  sectionId: DecorativeSiteExplorerSectionId,
  itemIds: readonly string[],
  name: string,
): string | null {
  const section = organization[sectionId]
  normalizeSectionInPlace(section)
  const selectedIds = uniqueExistingItemIds(section, itemIds)
  if (selectedIds.length === 0) return null

  const selected = orderedSelectedItems(section, selectedIds)
  const selectedSet = new Set(selectedIds)
  const rootEntries = rootEntriesForSection(section)
  const firstSelectedRootIndex = rootEntries.findIndex((entry) => {
    if (entry.kind === 'item') return selectedSet.has(entry.item.id)
    return section.items.some((item) => item.parentFolderId === entry.folder.id && selectedSet.has(item.id))
  })
  const insertIndex = rootEntries
    .slice(0, firstSelectedRootIndex === -1 ? rootEntries.length : firstSelectedRootIndex)
    .filter((entry) => entry.kind !== 'item' || !selectedSet.has(entry.item.id))
    .length

  const folderId = nanoid()
  const folder: SiteExplorerFolder = { id: folderId, name: name.trim() || 'Folder', order: 0 }
  section.folders.push(folder)

  const nextRootEntries = rootEntries
    .filter((entry) => entry.kind !== 'item' || !selectedSet.has(entry.item.id))
  nextRootEntries.splice(clampIndex(insertIndex, nextRootEntries.length), 0, {
    kind: 'folder',
    folder,
    order: folder.order,
  })
  applyRootEntryOrder(nextRootEntries)

  selected.forEach((item, order) => {
    item.parentFolderId = folderId
    item.order = order
  })
  normalizeSectionInPlace(section)
  return folderId
}

function normalizeSection(section: DecorativeExplorerSection): DecorativeExplorerSection {
  const folders = section.folders.map((folder) => ({
    id: folder.id,
    name: folder.name.trim() || 'Folder',
    order: Number.isFinite(folder.order) ? folder.order : 0,
  }))
  const folderIds = new Set(folders.map((folder) => folder.id))
  const items = section.items.map((item) => ({
    id: item.id,
    ...(item.parentFolderId && folderIds.has(item.parentFolderId) ? { parentFolderId: item.parentFolderId } : {}),
    order: Number.isFinite(item.order) ? item.order : 0,
  }))

  const rootEntries = [
    ...folders.map((folder) => ({
      kind: 'folder' as const,
      folder,
      order: folder.order,
    })),
    ...items
      .filter((item) => !item.parentFolderId)
      .map((item) => ({
        kind: 'item' as const,
        item,
        order: item.order,
      })),
  ]
  applyRootEntryOrder(sortRootEntries(rootEntries))

  const normalizedItems: SiteExplorerItemPlacement[] = []
  for (const entry of rootEntriesForSection({ folders, items })) {
    if (entry.kind === 'item') {
      normalizedItems.push({ id: entry.item.id, order: entry.item.order })
      continue
    }

    const children = items
      .filter((item) => item.parentFolderId === entry.folder.id)
      .sort((a, b) => a.order - b.order)
    children.forEach((item, order) => {
      normalizedItems.push({
        id: item.id,
        parentFolderId: entry.folder.id,
        order,
      })
    })
  }

  return {
    folders: [...folders].sort((a, b) => a.order - b.order),
    items: normalizedItems,
  }
}

function normalizeSectionInPlace(section: DecorativeExplorerSection): void {
  const normalized = normalizeSection(section)
  section.folders = normalized.folders
  section.items = normalized.items
}

function sortItems(items: readonly SiteExplorerItemPlacement[]): SiteExplorerItemPlacement[] {
  return [...items].sort((a, b) => a.order - b.order)
}

function rootEntriesForSection(section: DecorativeExplorerSection): SiteExplorerRootEntry[] {
  return sortRootEntries([
    ...section.folders.map((folder) => ({
      kind: 'folder' as const,
      folder,
      order: folder.order,
    })),
    ...section.items
      .filter((item) => !item.parentFolderId)
      .map((item) => ({
        kind: 'item' as const,
        item,
        order: item.order,
      })),
  ])
}

function sortRootEntries(entries: readonly SiteExplorerRootEntry[]): SiteExplorerRootEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.order - b.entry.order || a.index - b.index)
    .map(({ entry }) => entry)
}

function applyRootEntryOrder(entries: readonly SiteExplorerRootEntry[]): void {
  entries.forEach((entry, order) => {
    if (entry.kind === 'folder') {
      entry.folder.order = order
    } else {
      entry.item.order = order
    }
  })
}

function nextRootOrder(section: DecorativeExplorerSection): number {
  return rootEntriesForSection(section).length
}

function clampIndex(index: number, max: number): number {
  return Math.max(0, Math.min(index, max))
}

function uniqueExistingItemIds(
  section: DecorativeExplorerSection,
  itemIds: readonly string[],
): string[] {
  const existingIds = new Set(section.items.map((item) => item.id))
  const seen = new Set<string>()
  const selectedIds: string[] = []
  for (const id of itemIds) {
    if (!existingIds.has(id) || seen.has(id)) continue
    seen.add(id)
    selectedIds.push(id)
  }
  return selectedIds
}

function orderedSelectedItems(
  section: DecorativeExplorerSection,
  itemIds: readonly string[],
): SiteExplorerItemPlacement[] {
  const selectedIds = new Set(itemIds)
  return section.items.filter((item) => selectedIds.has(item.id))
}

export function reconcileSiteExplorerInPlace(site: SiteDocument): void {
  site.explorer = reconcileSiteExplorerOrganization(site.explorer, site)
}
