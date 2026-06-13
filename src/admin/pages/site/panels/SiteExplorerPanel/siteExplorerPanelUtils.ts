import type { SiteFile } from '@core/files/schemas'
import type { SiteExplorerSectionId } from '@core/page-tree'

type FileBucket = 'styles' | 'scripts'

const SECTION_ITEM_LABELS: Record<SiteExplorerSectionId, { singular: string; plural: string }> = {
  pages: { singular: 'page', plural: 'pages' },
  templates: { singular: 'template', plural: 'templates' },
  components: { singular: 'component', plural: 'components' },
  styles: { singular: 'stylesheet', plural: 'stylesheets' },
  scripts: { singular: 'script', plural: 'scripts' },
}

export function fileName(path: string) {
  return path.split('/').pop() ?? path
}

function fileExtension(path: string) {
  const name = fileName(path)
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index) : ''
}

export function pathFromRenameInput(currentPath: string, value: string) {
  const trimmed = value.trim()
  if (trimmed.includes('/')) return trimmed

  const slash = currentPath.lastIndexOf('/')
  const directory = slash >= 0 ? currentPath.slice(0, slash + 1) : ''
  const extension = fileExtension(currentPath)
  const nextName = extension && !trimmed.endsWith(extension) ? `${trimmed}${extension}` : trimmed
  return `${directory}${nextName}`
}

export function keyboardMenuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + Math.min(rect.width - 8, 24),
    y: rect.top + Math.min(rect.height - 8, 24),
  }
}

export function groupSiteFiles(files: SiteFile[]) {
  const visible = files.filter((file) => !file.generated || file.ejected)
  return {
    styles: visible.filter((file) => file.type === 'style'),
    scripts: visible.filter((file) => file.type === 'script'),
  } satisfies Record<FileBucket, SiteFile[]>
}

function sectionItemLabel(sectionId: SiteExplorerSectionId, count: number) {
  const labels = SECTION_ITEM_LABELS[sectionId]
  return count === 1 ? labels.singular : labels.plural
}

export function bulkSelectionLabel(sectionId: SiteExplorerSectionId, count: number) {
  return `${count} ${sectionItemLabel(sectionId, count)} selected`
}

export function bulkWrapLabel(sectionId: SiteExplorerSectionId, count: number) {
  return `Wrap ${count} ${sectionItemLabel(sectionId, count)} in folder`
}

export function bulkDeleteLabel(sectionId: SiteExplorerSectionId, count: number) {
  return `Delete ${count} ${sectionItemLabel(sectionId, count)}`
}

export function bulkDeleteConfirmTitle(sectionId: SiteExplorerSectionId, count: number) {
  return `Delete ${count} ${sectionItemLabel(sectionId, count)}?`
}

export function bulkDeleteConfirmLabel(sectionId: SiteExplorerSectionId, count: number) {
  return `Delete ${sectionItemLabel(sectionId, count)}`
}

export function bulkDeleteConfirmDescription(sectionId: SiteExplorerSectionId, count: number) {
  if (sectionId === 'components') {
    return 'This will remove the selected components and every reference to them.'
  }
  return `This will remove the selected ${sectionItemLabel(sectionId, count)}.`
}
