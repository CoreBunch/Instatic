import type {
  DataField,
  DataFieldType,
  DataIndex,
  DataPermissionPolicy,
  DataSeedRecord,
  DataTable,
  ProjectDataModel,
} from './types'
import { DEFAULT_DATA_PERMISSION_POLICY, EMPTY_PROJECT_DATA_MODEL } from './types'

const FIELD_TYPES: DataFieldType[] = [
  'string',
  'number',
  'boolean',
  'date',
  'text',
  'richText',
  'image',
  'file',
  'relation',
  'json',
]

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface DataModelDiagnostic {
  path: string
  message: string
}

export function slugifyTableName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!slug) return 'table'
  return /^[a-z_]/.test(slug) ? slug : `table_${slug}`
}

export function pluralizeSlug(slug: string): string {
  if (slug.endsWith('s')) return slug
  if (slug.endsWith('y')) return `${slug.slice(0, -1)}ies`
  return `${slug}s`
}

export function toValidFieldName(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^([0-9])/, '_$1')
    .replace(/^_+$/, '')
  return cleaned || 'field'
}

export function isValidIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizePermissions(raw: unknown): DataPermissionPolicy {
  const obj = asObject(raw)
  if (!obj) return { ...DEFAULT_DATA_PERMISSION_POLICY }
  return {
    read: obj.read === 'authenticated' || obj.read === 'owner' ? obj.read : 'public',
    create: obj.create === 'public' || obj.create === 'owner' ? obj.create : 'authenticated',
    update: obj.update === 'authenticated' ? 'authenticated' : 'owner',
    delete: obj.delete === 'authenticated' ? 'authenticated' : 'owner',
  }
}

function normalizeField(raw: unknown, fallbackIndex: number): DataField | null {
  const obj = asObject(raw)
  if (!obj) return null
  const id = typeof obj.id === 'string' && obj.id ? obj.id : `field_${fallbackIndex}`
  const name = typeof obj.name === 'string' ? toValidFieldName(obj.name) : `field_${fallbackIndex}`
  const type = FIELD_TYPES.includes(obj.type as DataFieldType) ? obj.type as DataFieldType : 'string'
  const relationObj = asObject(obj.relation)
  return {
    id,
    name,
    type,
    required: typeof obj.required === 'boolean' ? obj.required : false,
    list: typeof obj.list === 'boolean' ? obj.list : false,
    relation:
      relationObj && typeof relationObj.tableId === 'string'
        ? {
            tableId: relationObj.tableId,
            cardinality: relationObj.cardinality === 'many' ? 'many' : 'one',
          }
        : undefined,
    defaultValue: obj.defaultValue,
  }
}

function normalizeIndex(raw: unknown, fallbackIndex: number): DataIndex | null {
  const obj = asObject(raw)
  if (!obj) return null
  const id = typeof obj.id === 'string' && obj.id ? obj.id : `index_${fallbackIndex}`
  const fields = asStringArray(obj.fields)
  if (fields.length === 0) return null
  return {
    id,
    name: typeof obj.name === 'string' && obj.name ? obj.name : `by_${fields.join('_')}`,
    fields,
  }
}

function normalizeSeedRecord(raw: unknown, fallbackIndex: number): DataSeedRecord | null {
  const obj = asObject(raw)
  if (!obj) return null
  const now = Date.now()
  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : `seed_${fallbackIndex}`,
    values: asObject(obj.values) ?? {},
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : now,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : now,
  }
}

export function normalizeProjectDataModel(raw: unknown): ProjectDataModel {
  const obj = asObject(raw)
  if (!obj || !Array.isArray(obj.tables)) return structuredClone(EMPTY_PROJECT_DATA_MODEL)

  const tables: DataTable[] = []
  const seenSlugs = new Set<string>()
  for (let i = 0; i < obj.tables.length; i++) {
    const tableRaw = asObject(obj.tables[i])
    if (!tableRaw) continue
    const now = Date.now()
    const name = typeof tableRaw.name === 'string' && tableRaw.name.trim() ? tableRaw.name.trim() : `Table ${i + 1}`
    let slug = typeof tableRaw.slug === 'string' && tableRaw.slug.trim()
      ? slugifyTableName(tableRaw.slug)
      : pluralizeSlug(slugifyTableName(name))
    let suffix = 2
    while (seenSlugs.has(slug)) {
      slug = `${slug}_${suffix}`
      suffix += 1
    }
    seenSlugs.add(slug)

    const fieldNames = new Set<string>()
    const fields = Array.isArray(tableRaw.fields)
      ? tableRaw.fields
          .map((fieldRaw, fieldIndex) => normalizeField(fieldRaw, fieldIndex))
          .filter((field): field is DataField => {
            if (!field || fieldNames.has(field.name)) return false
            fieldNames.add(field.name)
            return true
          })
      : []

    const indexes = Array.isArray(tableRaw.indexes)
      ? tableRaw.indexes
          .map((indexRaw, indexIndex) => normalizeIndex(indexRaw, indexIndex))
          .filter((index): index is DataIndex =>
            Boolean(index && index.fields.every((fieldName) => fieldNames.has(fieldName))),
          )
      : []

    const seedRecords = Array.isArray(tableRaw.seedRecords)
      ? tableRaw.seedRecords
          .map((recordRaw, recordIndex) => normalizeSeedRecord(recordRaw, recordIndex))
          .filter((record): record is DataSeedRecord => Boolean(record))
      : []

    tables.push({
      id: typeof tableRaw.id === 'string' && tableRaw.id ? tableRaw.id : `table_${i}`,
      name,
      slug,
      pinned: typeof tableRaw.pinned === 'boolean' ? tableRaw.pinned : true,
      fields,
      indexes,
      permissions: normalizePermissions(tableRaw.permissions),
      seedRecords,
      createdAt: typeof tableRaw.createdAt === 'number' ? tableRaw.createdAt : now,
      updatedAt: typeof tableRaw.updatedAt === 'number' ? tableRaw.updatedAt : now,
    })
  }

  return { tables }
}

export function validateProjectDataModel(data: ProjectDataModel): DataModelDiagnostic[] {
  const diagnostics: DataModelDiagnostic[] = []
  const tableIds = new Set(data.tables.map((table) => table.id))
  const tableSlugs = new Set<string>()

  data.tables.forEach((table, tableIndex) => {
    const tablePath = `data.tables[${tableIndex}]`
    if (!table.name.trim()) diagnostics.push({ path: `${tablePath}.name`, message: 'Table name is required.' })
    if (!isValidIdentifier(table.slug)) diagnostics.push({ path: `${tablePath}.slug`, message: 'Table slug must be a safe identifier.' })
    if (tableSlugs.has(table.slug)) diagnostics.push({ path: `${tablePath}.slug`, message: 'Table slug must be unique.' })
    tableSlugs.add(table.slug)

    const fieldNames = new Set<string>()
    table.fields.forEach((field, fieldIndex) => {
      const fieldPath = `${tablePath}.fields[${fieldIndex}]`
      if (!isValidIdentifier(field.name)) diagnostics.push({ path: `${fieldPath}.name`, message: 'Field name must be a safe identifier.' })
      if (fieldNames.has(field.name)) diagnostics.push({ path: `${fieldPath}.name`, message: 'Field name must be unique in this table.' })
      fieldNames.add(field.name)
      if (field.type === 'relation' && (!field.relation || !tableIds.has(field.relation.tableId))) {
        diagnostics.push({ path: `${fieldPath}.relation`, message: 'Relation target table is missing.' })
      }
    })

    table.indexes.forEach((index, indexIndex) => {
      index.fields.forEach((fieldName) => {
        if (!fieldNames.has(fieldName)) {
          diagnostics.push({
            path: `${tablePath}.indexes[${indexIndex}].fields`,
            message: `Index references missing field "${fieldName}".`,
          })
        }
      })
    })
  })

  return diagnostics
}
