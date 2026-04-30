import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useEditorStore } from '@core/editor-store/store'
import { Button } from '@ui/components/Button'
import { Icon } from '@ui/icons/Icon'
import styles from './ResourceWorkspace.module.css'

export default function ResourceWorkspace() {
  const { tableSlug } = useParams<{ tableSlug: string }>()
  const project = useEditorStore((state) => state.project)
  const addDataSeedRecord = useEditorStore((state) => state.addDataSeedRecord)
  const updateDataSeedRecord = useEditorStore((state) => state.updateDataSeedRecord)
  const deleteDataSeedRecord = useEditorStore((state) => state.deleteDataSeedRecord)
  const table = useMemo(
    () => project?.data.tables.find((item) => item.slug === tableSlug) ?? null,
    [project, tableSlug],
  )

  if (!table) {
    return (
      <main className={styles.empty}>
        <Icon name="database" size={26} aria-hidden="true" />
        <h1>Resource not found</h1>
        <p>Create or pin a table in the Database workspace.</p>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{table.name}</h1>
          <p>Preview seed records. After publish, these can initialize the managed Convex table.</p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          accentFill
          onClick={() => addDataSeedRecord(table.id, Object.fromEntries(table.fields.map((field) => [field.name, ''])))}
        >
          <Icon name="plus" size={13} aria-hidden="true" />
          New record
        </Button>
      </header>

      <div className={styles.notice}>
        This MVP edits seed data stored in the builder project. Live Convex record editing is a later step.
      </div>

      {table.seedRecords.length === 0 ? (
        <section className={styles.emptyPanel}>
          <h2>No records yet</h2>
          <p>Add a seed record to preview dynamic content and include it in the first Convex publish.</p>
        </section>
      ) : (
        <section className={styles.records}>
          {table.seedRecords.map((record) => (
            <article key={record.id} className={styles.record}>
              <div className={styles.recordHeader}>
                <strong>{record.values.title as string || record.values.name as string || record.id}</strong>
                <Button type="button" variant="ghost" size="sm" onClick={() => deleteDataSeedRecord(table.id, record.id)}>
                  Delete
                </Button>
              </div>
              <div className={styles.fieldList}>
                {table.fields.map((field) => (
                  <label key={field.id}>
                    <span>{field.name}</span>
                    <input
                      value={String(record.values[field.name] ?? '')}
                      onChange={(event) => {
                        updateDataSeedRecord(table.id, record.id, {
                          ...record.values,
                          [field.name]: event.target.value,
                        })
                      }}
                    />
                  </label>
                ))}
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}

