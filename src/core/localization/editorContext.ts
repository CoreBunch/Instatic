import type { DataField } from '@core/data/schemas'
import { pageToCells } from '@core/data/pageFromRow'
import { visualComponentToCells } from '@core/data/componentFromRow'
import { savedLayoutToCells } from '@core/data/layoutFromRow'
import { parsePage, parsePageNodeTree, type BaseNode, type SiteDocument } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { parseVisualComponent, localizableComponentParameterIds, projectComponentParameterDefaults } from '@core/visualComponents'
import { parseSavedLayout } from '@core/layouts'
import type { ContentLocalizationDraftInput, SiteLocalizationContext } from '@core/localization-schema'
import { deepEqual } from '@core/utils/deepEqual'
import { materializeLocalizedCells, splitLocalizedCells } from './cells'
import { cloneContentValue } from './contentValues'
import { LocalizationValidationError } from './errors'
import { getLocalizablePropertyKeys, type PropertyLocalization } from './trees'
import { updateTranslationMetadata } from './review'

type EditorTableId = SiteLocalizationContext['rows'][string]['tableId']

/** Only field mode matters to cell projection; body is the shared editor tree. */
export function editorLocalizationFields(context: SiteLocalizationContext, tableId: EditorTableId): DataField[] {
  const policy = context.fieldLocalizations[tableId]
  if (!policy) throw new LocalizationValidationError(tableId, 'The editor requires the table localization policy.')
  return Object.entries(policy).map(([id, localization]) => ({
    id, label: id, type: id === 'body' ? 'pageTree' : id === 'parameterDefaults' ? 'parameterValues' : 'text', localization,
  }))
}

function editorRows(site: SiteDocument): Map<string, { tableId: EditorTableId; cells: Record<string, unknown>; slug: string; reference: object }> {
  return new Map<string, { tableId: EditorTableId; cells: Record<string, unknown>; slug: string; reference: object }>([
    ...site.pages.map((page) => [page.id, {
      tableId: 'pages' as const,
      cells: { ...pageToCells(page), templateEnabled: page.template?.enabled === true },
      slug: page.slug,
      reference: page,
    }] as const),
    ...site.visualComponents.map((component) => {
      const cells = visualComponentToCells(component)
      return [component.id, { tableId: 'components' as const, cells, slug: String(cells.slug ?? ''), reference: component }] as const
    }),
    ...site.layouts.map((layout) => {
      const cells = savedLayoutToCells(layout)
      return [layout.id, { tableId: 'layouts' as const, cells, slug: String(cells.slug ?? ''), reference: layout }] as const
    }),
  ])
}

export function canLocalizeEditorProperty(site: SiteDocument, node: BaseNode, key: string): PropertyLocalization {
  if (node.moduleId === 'base.visual-component-ref') {
    const component = site.visualComponents.find((entry) => entry.id === node.props.componentId)
    return key === 'propOverrides' && component ? localizableComponentParameterIds(component) : false
  }
  const module = registry.get(node.moduleId)
  return module ? getLocalizablePropertyKeys(module.schema).has(key) : false
}

/** Derive raw changes while the ordinary store mutation still edits its visible projection. */
export function captureSiteLocalization(
  before: SiteDocument,
  after: SiteDocument,
): SiteLocalizationContext | undefined {
  const context = before.localization
  const localeId = before.localeId
  if (!context || !localeId) return after.localization
  const sourceId = before.locales?.find((locale) => locale.isDefault)?.id
  if (!sourceId) throw new LocalizationValidationError('locales', 'A source locale is required.')
  if (localeId !== sourceId) {
    for (const key of ['name', 'breakpoints', 'conditions', 'settings', 'styleRules', 'files', 'packageJson', 'runtime'] as const) {
      if (!deepEqual(before[key], after[key])) {
        throw new LocalizationValidationError(key, 'Shared site design and settings must be edited in the source language.')
      }
    }
  }
  const previousRows = editorRows(before)
  const nextRows = editorRows(after)
  const result = { ...context, rows: { ...context.rows } }
  for (const id of previousRows.keys()) {
    if (nextRows.has(id)) continue
    if (localeId !== sourceId) {
      throw new LocalizationValidationError(id, 'Remove shared pages or components in the source language; use language publishing to take a translation offline.')
    }
    delete result.rows[id]
  }
  for (const [id, row] of nextRows) {
    const previous = previousRows.get(id)
    if (previous?.reference === row.reference) continue
    const current = context.rows[id]
    const fields = editorLocalizationFields(context, row.tableId)
    const split = splitLocalizedCells(fields, current?.sharedCells ?? {}, previous?.cells ?? {}, row.cells,
      current?.localizations[localeId]?.cells ?? {}, {
        allowStructureChanges: localeId === sourceId || !previous,
        canLocalizeProperty: (node, key) => canLocalizeEditorProperty(after, node, key),
      })
    if (localeId !== sourceId && previous && !deepEqual(split.sharedCells, current?.sharedCells ?? {})) {
      throw new LocalizationValidationError(id, 'Shared content settings must be edited in the source language.')
    }
    const nextDraft: ContentLocalizationDraftInput = {
      cells: split.localeCells,
      slug: row.slug,
      translationMeta: localeId === sourceId ? {} : updateTranslationMetadata(
        materializeLocalizedCells(fields, current?.sharedCells ?? {}, current?.localizations[sourceId]?.cells ?? {}, {}),
        current?.localizations[localeId]?.cells ?? {}, split.localeCells,
        current?.localizations[localeId]?.translationMeta ?? {},
      ),
    }
    result.rows[id] = {
      tableId: row.tableId,
      sharedCells: split.sharedCells,
      localizations: { ...current?.localizations, [localeId]: nextDraft },
    }
  }
  return result
}

/** Recompose from shared rows and sparse variants without replacing shared content. */
export function projectSiteLocale(site: SiteDocument, localeId: string, sharedOnly = false): SiteDocument {
  const context = site.localization
  if (!context) return { ...site, localeId }
  const sourceId = site.locales?.find((locale) => locale.isDefault)?.id
  if (!sourceId || !site.locales?.some((locale) => locale.id === localeId)) {
    throw new LocalizationValidationError('localeId', 'Unknown editor language.')
  }
  const read = (id: string) => {
    const row = context.rows[id]
    if (!row) return null
    const source = row.localizations[sourceId]
    const target = row.localizations[localeId]
    return {
      cells: sharedOnly ? cloneContentValue(row.sharedCells) : materializeLocalizedCells(
        editorLocalizationFields(context, row.tableId), row.sharedCells, source?.cells ?? {}, target?.cells ?? {},
      ),
      slug: sharedOnly ? String(row.sharedCells.slug ?? '') : target?.slug ?? source?.slug ?? '',
    }
  }
  return {
    ...site,
    localeId,
    pages: site.pages.map((page, index) => {
      const row = read(page.id)
      if (!row) return page
      const { cells, slug } = row
      const tree = parsePageNodeTree(cells.body)
      return parsePage({
        ...page, ...tree, slug,
        title: typeof cells.title === 'string' ? cells.title : '',
        seoTitle: cells.seoTitle,
        seoDescription: cells.seoDescription,
        template: cells.templateEnabled === true
          ? { enabled: true, target: cells.templateTarget, priority: cells.templatePriority }
          : undefined,
      }, index)
    }),
    visualComponents: site.visualComponents.map((component) => {
      const row = read(component.id)
      if (!row) return component
      const { cells } = row
      const projected = parseVisualComponent({
        ...component, name: typeof cells.name === 'string' && cells.name ? cells.name : component.id,
        tree: cells.body, params: cells.params ?? [], classIds: cells.classIds ?? [],
      })
      if (!projected) throw new LocalizationValidationError(component.id, 'Invalid shared component structure.')
      return sharedOnly ? projected : projectComponentParameterDefaults(projected, cells.parameterDefaults)
    }),
    layouts: site.layouts.map((layout) => {
      const row = read(layout.id)
      if (!row) return layout
      const { cells } = row
      const tree = parsePageNodeTree(cells.body)
      const projected = parseSavedLayout({
        ...layout, ...tree, name: typeof cells.name === 'string' && cells.name ? cells.name : layout.id,
        classes: cells.classes ?? {},
      })
      if (!projected) throw new LocalizationValidationError(layout.id, 'Invalid shared layout structure.')
      return projected
    }),
  }
}
