import type { ContentTableSchema as ContentTableSchemaShape } from '@core/plugin-sdk/contentSchemas'
import type { PluginRepeaterItemField } from '@core/plugin-sdk/types/content'
import type { DataField, RepeaterItemField } from '@core/data/schemas'
import { listDataTables } from '../../repositories/data'
import type { DbClient } from '../../db/client'
import { MAIN_SCOPE } from '../../branches/scope'

function pluginFieldCommon(field: { id: string; label: string; required?: boolean }): {
  id: string
  label: string
  required?: boolean
} {
  return {
    id: field.id,
    label: field.label,
    ...(field.required !== undefined ? { required: field.required } : {}),
  }
}

function pluginRepeaterItemFieldToDataField(
  field: PluginRepeaterItemField,
  tableIdBySlug: Map<string, string>,
): RepeaterItemField {
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'number':
    case 'boolean':
    case 'date':
    case 'dateTime':
    case 'url':
    case 'email':
      return { ...pluginFieldCommon(field), type: field.type }
    case 'richText':
      return { ...pluginFieldCommon(field), type: field.type, format: 'markdown' }
    case 'select':
    case 'multiSelect':
      return {
        ...pluginFieldCommon(field),
        type: field.type,
        options: field.options.map((option) => ({
          id: option.value,
          value: option.value,
          label: option.label,
        })),
      }
    case 'media':
      return {
        ...pluginFieldCommon(field),
        type: field.type,
        mediaKind: field.mediaKind,
        allowMultiple: field.allowMultiple,
      }
    case 'relation': {
      const targetTableId = tableIdBySlug.get(field.targetTableSlug)
      if (!targetTableId) {
        throw new Error(
          `Relation field "${field.id}" targets unknown table "${field.targetTableSlug}"`,
        )
      }
      return {
        ...pluginFieldCommon(field),
        type: field.type,
        targetTableId,
        allowMultiple: field.allowMultiple,
      }
    }
  }
}

export async function buildContentTableIdLookup(db: DbClient): Promise<Map<string, string>> {
  const tables = await listDataTables(db, MAIN_SCOPE)
  return new Map(tables.map((t) => [t.slug, t.id]))
}

export function pluginContentFieldsToDataFields(
  fields: ContentTableSchemaShape['fields'],
  tableIdBySlug: Map<string, string>,
): DataField[] {
  const out: DataField[] = []

  for (const field of fields) {
    switch (field.type) {
      case 'text':
      case 'longText':
      case 'number':
      case 'boolean':
      case 'date':
      case 'dateTime':
      case 'url':
      case 'email':
      case 'media':
      case 'pageTree':
        out.push({ ...pluginFieldCommon(field), type: field.type })
        break
      case 'richText':
        out.push({ ...pluginFieldCommon(field), type: field.type, format: 'markdown' })
        break
      case 'select':
      case 'multiSelect':
        out.push({
          ...pluginFieldCommon(field),
          type: field.type,
          options: field.options.map((option) => ({
            id: option.value,
            value: option.value,
            label: option.label,
          })),
        })
        break
      case 'relation': {
        const targetTableId = tableIdBySlug.get(field.targetTableSlug)
        if (!targetTableId) {
          throw new Error(`Relation field "${field.id}" targets unknown table "${field.targetTableSlug}"`)
        }
        out.push({
          ...pluginFieldCommon(field),
          type: field.type,
          targetTableId,
        })
        break
      }
      case 'repeater':
        out.push({
          ...pluginFieldCommon(field),
          type: field.type,
          fields: field.fields.map((itemField) =>
            pluginRepeaterItemFieldToDataField(itemField, tableIdBySlug)),
          itemLabelFieldId: field.itemLabelFieldId,
        })
        break
    }
  }

  return out
}
