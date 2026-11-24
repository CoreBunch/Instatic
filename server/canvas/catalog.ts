import { escapeHtml } from '@core/html-sanitize'
import { registry } from '@core/module-engine'
import type { DataTableListItem } from '@core/data/schemas'
import { describeAgentModules } from '../ai/tools/site/render'
import { describeLoopSources } from './loopCatalog'

export function canvasModules(id: string | null) {
  const modules = describeAgentModules()
  if (!id) return { modules: modules.map(({ id, name, category, description }) => ({ id, name, category, description })) }
  const module = modules.find(item => item.id === id)
  return module ? { module, propsSchema: registry.getOrThrow(id).propsSchema } : null
}

export function canvasCollections(tables: DataTableListItem[], ref: string | null, query: string) {
  const catalog = describeLoopSources(tables)
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const phrase = ' ' + normalize(query) + ' '
  const matches = catalog.dataTables.filter(t => ref
    ? t.id === ref || t.slug === ref
    : [t.slug, t.name, t.singularLabel, t.pluralLabel].some(label => label && phrase.includes(' ' + normalize(label) + ' ')))
  if (ref && !matches.length) return null
  if (matches.length !== 1) return {
    collections: (matches.length ? matches : catalog.dataTables).map(({ id, name, slug }) => ({ id, name, slug })),
    sources: catalog.sources.map(({ id, label }) => ({ id, label })),
    command: 'instatic canvas collection TABLE_ID_OR_SLUG --branch BRANCH',
  }
  const table = matches[0]
  const date = table.fields.find(field => field.type === 'date')
  const title = '{currentEntry.' + (table.primaryFieldId || 'title') + '}'
  const label = table.routable ? '<a href="{currentEntry.permalink}">' + escapeHtml(title) + '</a>' : escapeHtml(title)
  const orderBy = date ? 'cell:' + date.id : 'createdAt'
  const direction = date ? 'asc' : 'desc'
  const props = { sourceId: 'data.rows', filters: { tableId: table.id }, orderBy, direction, limit: 10 }
  const html = '<instatic-loop data-source-id="data.rows" data-table-id="' + escapeHtml(table.id) + '" data-order-by="' +
    escapeHtml(orderBy) + '" data-direction="' + direction + '" data-limit="10"><article><h2>' + label +
    '</h2>' + (date ? '<p>' + escapeHtml(date.token) + '</p>' : '') + '</article></instatic-loop>'
  return {
    table, source: catalog.sources.find(source => source.id === 'data.rows'),
    module: 'base.loop', props, edit: { op: 'insertHtml', parent: 'PARENT_NODE_ID', html },
    usage: 'Replace parent with a node ID from canvas read. Children of the loop repeat for each row. Set the limit and order to suit the listing. Use visit on the directory and its detail links to verify.',
  }
}
