export type DataFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'text'
  | 'richText'
  | 'image'
  | 'file'
  | 'relation'
  | 'json'

export interface ProjectDataModel {
  tables: DataTable[]
}

export interface DataTable {
  id: string
  name: string
  slug: string
  pinned: boolean
  fields: DataField[]
  indexes: DataIndex[]
  permissions: DataPermissionPolicy
  seedRecords: DataSeedRecord[]
  createdAt: number
  updatedAt: number
}

export interface DataField {
  id: string
  name: string
  type: DataFieldType
  required: boolean
  list: boolean
  relation?: { tableId: string; cardinality: 'one' | 'many' }
  defaultValue?: unknown
}

export interface DataIndex {
  id: string
  name: string
  fields: string[]
}

export interface DataPermissionPolicy {
  read: 'public' | 'authenticated' | 'owner'
  create: 'public' | 'authenticated' | 'owner'
  update: 'authenticated' | 'owner'
  delete: 'authenticated' | 'owner'
}

export interface DataSeedRecord {
  id: string
  values: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export const DEFAULT_DATA_PERMISSION_POLICY: DataPermissionPolicy = {
  read: 'public',
  create: 'authenticated',
  update: 'owner',
  delete: 'owner',
}

export const EMPTY_PROJECT_DATA_MODEL: ProjectDataModel = {
  tables: [],
}

