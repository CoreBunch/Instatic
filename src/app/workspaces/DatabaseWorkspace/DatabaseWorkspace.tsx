import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useEditorStore } from '@core/editor-store/store'
import type { DataFieldType, DataTable } from '@core/data-model/types'
import { validateProjectDataModel } from '@core/data-model/validation'
import { Button } from '@ui/components/Button'
import { Icon } from '@ui/icons/Icon'
import styles from './DatabaseWorkspace.module.css'

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

export default function DatabaseWorkspace() {
  const navigate = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const project = useEditorStore((state) => state.project)
  const createDataTable = useEditorStore((state) => state.createDataTable)
  const renameDataTable = useEditorStore((state) => state.renameDataTable)
  const deleteDataTable = useEditorStore((state) => state.deleteDataTable)
  const setDataTablePinned = useEditorStore((state) => state.setDataTablePinned)
  const addDataField = useEditorStore((state) => state.addDataField)
  const updateDataField = useEditorStore((state) => state.updateDataField)
  const deleteDataField = useEditorStore((state) => state.deleteDataField)
  const addDataIndex = useEditorStore((state) => state.addDataIndex)
  const deleteDataIndex = useEditorStore((state) => state.deleteDataIndex)
  const updateDataPermissions = useEditorStore((state) => state.updateDataPermissions)
  const [activeTableId, setActiveTableId] = useState<string | null>(null)
  const [newTableName, setNewTableName] = useState('Posts')
  const [newFieldName, setNewFieldName] = useState('title')
  const [newFieldType, setNewFieldType] = useState<DataFieldType>('string')
  const [indexField, setIndexField] = useState('')

  const tables = project?.data.tables ?? []
  const activeTable = tables.find((table) => table.id === activeTableId) ?? tables[0] ?? null
  const diagnostics = useMemo(() => project ? validateProjectDataModel(project.data) : [], [project])

  function handleCreateTable() {
    const table = createDataTable(newTableName)
    setActiveTableId(table.id)
    setNewTableName('')
  }

  function openResource(table: DataTable) {
    navigate(`/projects/${projectId ?? project?.id ?? 'new-project'}/resources/${table.slug}`)
  }

  return (
    <main className={styles.page}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div>
            <h1>Database</h1>
            <p>{tables.length} table{tables.length === 1 ? '' : 's'}</p>
          </div>
        </div>

        <div className={styles.createRow}>
          <input
            value={newTableName}
            onChange={(event) => setNewTableName(event.target.value)}
            placeholder="Table name"
            aria-label="New table name"
          />
          <Button type="button" variant="secondary" size="sm" onClick={handleCreateTable}>
            <Icon name="plus" size={13} aria-hidden="true" />
            Add
          </Button>
        </div>

        <div className={styles.tableList}>
          {tables.map((table) => (
            <Button
              key={table.id}
              type="button"
              variant="ghost"
              size="md"
              fullWidth
              align="between"
              active={activeTable?.id === table.id}
              className={activeTable?.id === table.id ? `${styles.tableItem} ${styles.tableItemActive}` : styles.tableItem}
              onClick={() => setActiveTableId(table.id)}
            >
              <span>{table.name}</span>
              <small>{table.fields.length} fields</small>
            </Button>
          ))}
        </div>
      </aside>

      <section className={styles.main}>
        {!activeTable && (
          <div className={styles.empty}>
            <Icon name="database" size={26} aria-hidden="true" />
            <h2>Create a table</h2>
            <p>Tables define the Convex schema and the resource workspaces your app can use.</p>
          </div>
        )}

        {activeTable && (
          <>
            <div className={styles.header}>
              <div>
                <input
                  className={styles.titleInput}
                  value={activeTable.name}
                  onChange={(event) => renameDataTable(activeTable.id, event.target.value)}
                  aria-label="Table name"
                />
                <p>Convex table: <code>{activeTable.slug}</code></p>
              </div>
              <div className={styles.headerActions}>
                <Button type="button" variant="secondary" size="sm" onClick={() => openResource(activeTable)}>
                  <Icon name="table-row-plus" size={13} aria-hidden="true" />
                  Records
                </Button>
                <label className={styles.pinToggle}>
                  <input
                    type="checkbox"
                    checked={activeTable.pinned}
                    onChange={(event) => setDataTablePinned(activeTable.id, event.target.checked)}
                  />
                  Pinned
                </label>
                <Button type="button" variant="destructive" size="sm" onClick={() => deleteDataTable(activeTable.id)}>
                  Delete
                </Button>
              </div>
            </div>

            {diagnostics.length > 0 && (
              <div className={styles.diagnostics}>
                {diagnostics.map((diagnostic) => (
                  <p key={`${diagnostic.path}:${diagnostic.message}`}>
                    <strong>{diagnostic.path}</strong> {diagnostic.message}
                  </p>
                ))}
              </div>
            )}

            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Fields</h2>
                <div className={styles.createRowInline}>
                  <input
                    value={newFieldName}
                    onChange={(event) => setNewFieldName(event.target.value)}
                    placeholder="Field name"
                    aria-label="New field name"
                  />
                  <select
                    value={newFieldType}
                    onChange={(event) => setNewFieldType(event.target.value as DataFieldType)}
                    aria-label="New field type"
                  >
                    {FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      addDataField(activeTable.id, { name: newFieldName, type: newFieldType })
                      setNewFieldName('')
                    }}
                  >
                    Add field
                  </Button>
                </div>
              </div>

              <div className={styles.fieldGrid} role="table" aria-label={`${activeTable.name} fields`}>
                <div className={styles.gridHead}>Name</div>
                <div className={styles.gridHead}>Type</div>
                <div className={styles.gridHead}>Required</div>
                <div className={styles.gridHead}>List</div>
                <div className={styles.gridHead}>Actions</div>
                {activeTable.fields.map((field) => (
                  <div key={field.id} className={styles.gridRow} role="row">
                    <input
                      value={field.name}
                      onChange={(event) => updateDataField(activeTable.id, field.id, { name: event.target.value })}
                      aria-label={`${field.name} field name`}
                    />
                    <select
                      value={field.type}
                      onChange={(event) => updateDataField(activeTable.id, field.id, { type: event.target.value as DataFieldType })}
                      aria-label={`${field.name} field type`}
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                    <label>
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(event) => updateDataField(activeTable.id, field.id, { required: event.target.checked })}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={field.list}
                        onChange={(event) => updateDataField(activeTable.id, field.id, { list: event.target.checked })}
                      />
                    </label>
                    <Button type="button" variant="ghost" size="sm" onClick={() => deleteDataField(activeTable.id, field.id)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.twoColumn}>
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <h2>Indexes</h2>
                  <div className={styles.createRowInline}>
                    <select value={indexField} onChange={(event) => setIndexField(event.target.value)} aria-label="Index field">
                      <option value="">Choose field</option>
                      {activeTable.fields.map((field) => (
                        <option key={field.id} value={field.name}>{field.name}</option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!indexField}
                      onClick={() => {
                        addDataIndex(activeTable.id, [indexField])
                        setIndexField('')
                      }}
                    >
                      Add index
                    </Button>
                  </div>
                </div>
                {activeTable.indexes.length === 0 ? (
                  <p className={styles.muted}>No indexes yet.</p>
                ) : (
                  activeTable.indexes.map((index) => (
                    <div key={index.id} className={styles.indexRow}>
                      <span><code>{index.name}</code> on {index.fields.join(', ')}</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => deleteDataIndex(activeTable.id, index.id)}>
                        Remove
                      </Button>
                    </div>
                  ))
                )}
              </div>

              <div className={styles.panel}>
                <h2>Permissions</h2>
                <div className={styles.permissionGrid}>
                  {(['read', 'create', 'update', 'delete'] as const).map((permission) => (
                    <label key={permission}>
                      <span>{permission}</span>
                      <select
                        value={activeTable.permissions[permission]}
                        onChange={(event) => updateDataPermissions(activeTable.id, { [permission]: event.target.value } as never)}
                      >
                        {(permission === 'read' || permission === 'create') && <option value="public">public</option>}
                        <option value="authenticated">authenticated</option>
                        <option value="owner">owner</option>
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  )
}
