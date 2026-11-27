import '@core/loops/sources'
import { buildDataMeta } from '@core/data/fields'
import type { DataMetaField, DataTableListItem } from '@core/data/schemas'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopSourceField } from '@core/loops/types'

type AgentBindingFormat = NonNullable<LoopSourceField['format']>

interface AgentBindingField {
  id: string
  label: string
  token: string
  format?: AgentBindingFormat
  type?: DataMetaField['type']
}

function currentEntryToken(fieldId: string): string {
  return `{currentEntry.${fieldId}}`
}

function loopFieldToAgentField(field: LoopSourceField): AgentBindingField {
  return {
    id: field.id,
    label: field.label,
    token: currentEntryToken(field.id),
    ...(field.format ? { format: field.format } : {}),
  }
}

function dataMetaFieldFormat(field: DataMetaField): AgentBindingFormat | undefined {
  switch (field.type) {
    case 'richText':
      return 'html'
    case 'url':
      return 'url'
    case 'media':
      return 'media'
    default:
      return undefined
  }
}

function dataMetaFieldToAgentField(field: DataMetaField): AgentBindingField {
  const format = dataMetaFieldFormat(field)
  return {
    id: field.id,
    label: field.label,
    type: field.type,
    token: currentEntryToken(field.id),
    ...(format ? { format } : {}),
  }
}

function mergeBindingFields(fields: AgentBindingField[]): AgentBindingField[] {
  const byId = new Map<string, AgentBindingField>()
  for (const field of fields) byId.set(field.id, field)
  return Array.from(byId.values())
}

export function describeLoopSources(tables: DataTableListItem[]) {
  const sources = loopSourceRegistry.list().map((source) => ({
    id: source.id,
    label: source.label,
    description: source.description,
    requestDependent: source.requestDependent === true,
    perVisitor: source.perVisitor === true,
    fields: source.fields.map(loopFieldToAgentField),
    filterSchema: source.filterSchema,
    orderByOptions: source.orderByOptions,
    // Leave out data-direction to get this; set it only to override.
    defaultDirection: source.defaultDirection ?? 'asc',
  }))
  const dataMeta = buildDataMeta(tables)
  const dataRowsSource = loopSourceRegistry.get('data.rows')
  const dataRowsFields = dataRowsSource?.fields.map(loopFieldToAgentField) ?? []
  return {
    usage: {
      loopElement: '<instatic-loop data-source-id="data.rows" data-table-id="<table id>" data-order-by="publishedAt" data-limit="3">...</instatic-loop>',
      direction: 'Omit data-direction to keep the source\'s own order (each source lists its defaultDirection). Add data-direction="asc" or "desc" only to override it.',
      tokenSyntax: '{currentEntry.field}',
      invalidTokenSyntax: '{{post.field}}',
    },
    sources,
    dataTables: dataMeta.tables.map((table) => ({
      id: table.id,
      slug: table.slug,
      name: table.name,
      kind: table.kind,
      singularLabel: table.singularLabel,
      pluralLabel: table.pluralLabel,
      primaryFieldId: table.primaryFieldId,
      routable: table.routable,
      versioned: table.versioned,
      rowCount: tables.find((t) => t.id === table.id)?.rowCount ?? 0,
      fields: mergeBindingFields([
        ...table.fields.map(dataMetaFieldToAgentField),
        ...dataRowsFields,
      ]),
    })),
  }
}
