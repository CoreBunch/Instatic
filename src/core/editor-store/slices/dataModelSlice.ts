import { produce } from 'immer'
import { nanoid } from 'nanoid'
import type { StateCreator } from 'zustand'
import type { EditorStore } from '../store'
import type {
  DataField,
  DataFieldType,
  DataIndex,
  DataPermissionPolicy,
  DataSeedRecord,
  DataTable,
} from '../../data-model/types'
import { DEFAULT_DATA_PERMISSION_POLICY } from '../../data-model/types'
import { pluralizeSlug, slugifyTableName, toValidFieldName } from '../../data-model/validation'

export interface DataModelSlice {
  createDataTable(name: string): DataTable
  renameDataTable(tableId: string, name: string): void
  deleteDataTable(tableId: string): void
  setDataTablePinned(tableId: string, pinned: boolean): void
  addDataField(tableId: string, field: { name: string; type: DataFieldType }): DataField
  updateDataField(tableId: string, fieldId: string, patch: Partial<Omit<DataField, 'id'>>): void
  deleteDataField(tableId: string, fieldId: string): void
  addDataIndex(tableId: string, fields: string[]): DataIndex
  deleteDataIndex(tableId: string, indexId: string): void
  updateDataPermissions(tableId: string, patch: Partial<DataPermissionPolicy>): void
  addDataSeedRecord(tableId: string, values?: Record<string, unknown>): DataSeedRecord
  updateDataSeedRecord(tableId: string, recordId: string, values: Record<string, unknown>): void
  deleteDataSeedRecord(tableId: string, recordId: string): void
}

function uniqueTableSlug(existing: DataTable[], name: string): string {
  const base = pluralizeSlug(slugifyTableName(name))
  const used = new Set(existing.map((table) => table.slug))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

function uniqueFieldName(table: DataTable, name: string): string {
  const base = toValidFieldName(name)
  const used = new Set(table.fields.map((field) => field.name))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

function markDirty(state: EditorStore) {
  if (!state.project) return
  state.project.updatedAt = Date.now()
  state.hasUnsavedChanges = true
}

export const createDataModelSlice: StateCreator<EditorStore, [], [], DataModelSlice> = (set, get) => ({
  createDataTable(name) {
    const { project, pushHistory } = get()
    if (!project) throw new Error('[dataModelSlice] No project loaded')
    pushHistory()
    const now = Date.now()
    const table: DataTable = {
      id: nanoid(),
      name: name.trim() || 'Untitled table',
      slug: uniqueTableSlug(project.data.tables, name),
      pinned: true,
      fields: [],
      indexes: [],
      permissions: { ...DEFAULT_DATA_PERMISSION_POLICY },
      seedRecords: [],
      createdAt: now,
      updatedAt: now,
    }
    set(
      produce((state: EditorStore) => {
        state.project?.data.tables.push(table)
        markDirty(state)
      }),
    )
    return table
  },

  renameDataTable(tableId, name) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        if (!table) return
        table.name = name.trim() || table.name
        table.updatedAt = Date.now()
        markDirty(state)
      }),
    )
  },

  deleteDataTable(tableId) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        if (!state.project) return
        state.project.data.tables = state.project.data.tables.filter((table) => table.id !== tableId)
        for (const table of state.project.data.tables) {
          table.fields = table.fields.filter((field) => field.relation?.tableId !== tableId)
        }
        markDirty(state)
      }),
    )
  },

  setDataTablePinned(tableId, pinned) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        if (!table) return
        table.pinned = pinned
        table.updatedAt = Date.now()
        markDirty(state)
      }),
    )
  },

  addDataField(tableId, field) {
    const { project, pushHistory } = get()
    if (!project) throw new Error('[dataModelSlice] No project loaded')
    const table = project.data.tables.find((item) => item.id === tableId)
    if (!table) throw new Error('[dataModelSlice] Table not found')
    pushHistory()
    const newField: DataField = {
      id: nanoid(),
      name: uniqueFieldName(table, field.name),
      type: field.type,
      required: false,
      list: false,
    }
    set(
      produce((state: EditorStore) => {
        const target = state.project?.data.tables.find((item) => item.id === tableId)
        if (!target) return
        target.fields.push(newField)
        target.updatedAt = Date.now()
        markDirty(state)
      }),
    )
    return newField
  },

  updateDataField(tableId, fieldId, patch) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        const field = table?.fields.find((item) => item.id === fieldId)
        if (!table || !field) return
        if (typeof patch.name === 'string') {
          const previousName = field.name
          const nextName = uniqueFieldName({ ...table, fields: table.fields.filter((item) => item.id !== fieldId) }, patch.name)
          field.name = nextName
          for (const index of table.indexes) {
            index.fields = index.fields.map((fieldName) => fieldName === previousName ? nextName : fieldName)
            index.name = `by_${index.fields.join('_')}`
          }
          for (const record of table.seedRecords) {
            if (Object.prototype.hasOwnProperty.call(record.values, previousName)) {
              record.values[nextName] = record.values[previousName]
              delete record.values[previousName]
              record.updatedAt = Date.now()
            }
          }
        }
        if (patch.type) field.type = patch.type
        if (typeof patch.required === 'boolean') field.required = patch.required
        if (typeof patch.list === 'boolean') field.list = patch.list
        if (patch.relation !== undefined) field.relation = patch.relation
        if ('defaultValue' in patch) field.defaultValue = patch.defaultValue
        table.updatedAt = Date.now()
        markDirty(state)
      }),
    )
  },

  deleteDataField(tableId, fieldId) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        if (!table) return
        const field = table.fields.find((item) => item.id === fieldId)
        table.fields = table.fields.filter((item) => item.id !== fieldId)
        if (field) {
          table.indexes = table.indexes
            .map((index) => ({ ...index, fields: index.fields.filter((name) => name !== field.name) }))
            .filter((index) => index.fields.length > 0)
          for (const record of table.seedRecords) {
            delete record.values[field.name]
          }
        }
        table.updatedAt = Date.now()
        markDirty(state)
      }),
    )
  },

  addDataIndex(tableId, fields) {
    const { project, pushHistory } = get()
    if (!project) throw new Error('[dataModelSlice] No project loaded')
    const table = project.data.tables.find((item) => item.id === tableId)
    if (!table) throw new Error('[dataModelSlice] Table not found')
    const validFields = fields.filter((fieldName) => table.fields.some((field) => field.name === fieldName))
    if (validFields.length === 0) throw new Error('[dataModelSlice] Index needs at least one field')
    pushHistory()
    const index: DataIndex = {
      id: nanoid(),
      name: `by_${validFields.join('_')}`,
      fields: validFields,
    }
    set(
      produce((state: EditorStore) => {
        const target = state.project?.data.tables.find((item) => item.id === tableId)
        if (!target) return
        target.indexes.push(index)
        target.updatedAt = Date.now()
        markDirty(state)
      }),
    )
    return index
  },

  deleteDataIndex(tableId, indexId) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        if (!table) return
        table.indexes = table.indexes.filter((index) => index.id !== indexId)
        table.updatedAt = Date.now()
        markDirty(state)
      }),
    )
  },

  updateDataPermissions(tableId, patch) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        if (!table) return
        Object.assign(table.permissions, patch)
        table.updatedAt = Date.now()
        markDirty(state)
      }),
    )
  },

  addDataSeedRecord(tableId, values = {}) {
    const { pushHistory } = get()
    pushHistory()
    const now = Date.now()
    const record: DataSeedRecord = {
      id: nanoid(),
      values,
      createdAt: now,
      updatedAt: now,
    }
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        if (!table) return
        table.seedRecords.push(record)
        table.updatedAt = now
        markDirty(state)
      }),
    )
    return record
  },

  updateDataSeedRecord(tableId, recordId, values) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        const record = table?.seedRecords.find((item) => item.id === recordId)
        if (!table || !record) return
        record.values = values
        record.updatedAt = Date.now()
        table.updatedAt = Date.now()
        markDirty(state)
      }),
    )
  },

  deleteDataSeedRecord(tableId, recordId) {
    const { pushHistory } = get()
    pushHistory()
    set(
      produce((state: EditorStore) => {
        const table = state.project?.data.tables.find((item) => item.id === tableId)
        if (!table) return
        table.seedRecords = table.seedRecords.filter((record) => record.id !== recordId)
        table.updatedAt = Date.now()
        markDirty(state)
      }),
    )
  },
})
