import {
  useEffect,
  useState,
  type CSSProperties,
} from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import type {
  PluginAdminAppComponent,
  PluginAdminPageRoute,
  PluginPageContent,
  PluginRecord,
  PluginResource,
  PluginResourceField,
} from '@core/plugin-sdk'
import {
  buildPluginRoutesHelper,
  loadPluginAdminAppComponent,
  type PluginAdminAppImport,
} from '@core/plugins/adminRuntime'
import { pluginCacheKey } from '@core/plugins/cacheBuster'
import {
  createCmsPluginResourceRecord,
  deleteCmsPluginResourceRecord,
  getCmsPluginResource,
} from '@core/persistence'
import { pluginRuntime } from '@core/plugins/runtime'
import {
  PluginContext,
  type PluginContextValue,
} from '@admin/plugin-host-hooks'
import { ensurePluginRuntime } from '@admin/pluginRuntimeBootstrap'
import { SkeletonBlock, SkeletonRows } from '@ui/components/Skeleton'
import styles from '../../PluginsPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Module-level helpers — extracted so the React Compiler can auto-memoize
// PluginResourcePage (try/catch in async causes compiler bailout when nested
// inside a component function).
// ---------------------------------------------------------------------------

/**
 * Load a plugin resource and its records. Takes `isCancelled` as a getter
 * (not a captured boolean) so reads always reflect the latest value after
 * the async boundary, even if the effect cleanup ran first.
 */
async function loadPluginResource(
  pluginId: string,
  resourceId: string,
  isCancelled: () => boolean,
  setLoading: (v: boolean) => void,
  setError: (v: string | null) => void,
  setResource: (v: PluginResource | null) => void,
  setRecords: (v: PluginRecord[]) => void,
  setFormData: (v: Record<string, string | boolean>) => void,
): Promise<void> {
  setLoading(true)
  setError(null)
  try {
    const payload = await getCmsPluginResource(pluginId, resourceId)
    if (isCancelled()) return
    setResource(payload.resource)
    setRecords(payload.records)
    setFormData(emptyForm(payload.resource))
  } catch (err) {
    if (!isCancelled()) setError(getErrorMessage(err, 'Could not load plugin records'))
  } finally {
    if (!isCancelled()) setLoading(false)
  }
}

async function createPluginRecord(
  pluginId: string,
  resource: PluginResource,
  data: Record<string, unknown>,
  setSaving: (v: boolean) => void,
  setError: (v: string | null) => void,
  setRecords: (updater: (current: PluginRecord[]) => PluginRecord[]) => void,
  setFormData: (v: Record<string, string | boolean>) => void,
): Promise<void> {
  setSaving(true)
  setError(null)
  try {
    const record = await createCmsPluginResourceRecord(pluginId, resource.id, data)
    setRecords((current) => [record, ...current])
    setFormData(emptyForm(resource))
  } catch (err) {
    setError(getErrorMessage(err, 'Could not create record'))
  } finally {
    setSaving(false)
  }
}

async function deletePluginRecord(
  pluginId: string,
  resourceId: string,
  recordId: string,
  setError: (v: string | null) => void,
  setRecords: (updater: (current: PluginRecord[]) => PluginRecord[]) => void,
): Promise<void> {
  setError(null)
  try {
    await deleteCmsPluginResourceRecord(pluginId, resourceId, recordId)
    setRecords((current) => current.filter((candidate) => candidate.id !== recordId))
  } catch (err) {
    setError(getErrorMessage(err, 'Could not delete record'))
  }
}

interface PluginPageRendererProps {
  page: PluginAdminPageRoute
  importModule?: PluginAdminAppImport
}

type ResourcePluginPageRoute = PluginAdminPageRoute & {
  content: Extract<PluginPageContent, { kind: 'resource' }>
}

type AppPluginPageRoute = PluginAdminPageRoute & {
  content: Extract<PluginPageContent, { kind: 'app' }>
}

export function PluginPageRenderer({ page, importModule }: PluginPageRendererProps) {
  // Plugins are user-installed code — a render failure inside one must not
  // blank the admin shell. Reset key combines plugin id + page id so
  // navigating between plugin pages naturally clears stuck errors.
  return (
    <ErrorBoundary
      location="plugin-page"
      resetKeys={[page.pluginId, page.id]}
    >
      <PluginPageContent page={page} importModule={importModule} />
    </ErrorBoundary>
  )
}

function PluginPageContent({ page, importModule }: PluginPageRendererProps) {
  if (page.content.kind === 'map') {
    return (
      <div className={styles.mapSurface} aria-label={page.title}>
        <div className={styles.mapGrid} aria-hidden="true" />
        {page.content.centerLabel && (
          <div className={styles.mapCenterLabel}>{page.content.centerLabel}</div>
        )}
        {page.content.pins.map((pin) => (
          <article
            key={`${pin.label}-${pin.x}-${pin.y}`}
            className={styles.mapPin}
            style={{ '--pin-x': `${pin.x}%`, '--pin-y': `${pin.y}%` } as CSSProperties}
          >
            <span aria-hidden="true" />
            <strong>{pin.label}</strong>
            {pin.detail && <small>{pin.detail}</small>}
          </article>
        ))}
      </div>
    )
  }

  if (page.content.kind === 'resource') {
    return <PluginResourcePage page={page as ResourcePluginPageRoute} />
  }

  if (page.content.kind === 'app') {
    return <PluginAppPage page={page as AppPluginPageRoute} importModule={importModule} />
  }

  return (
    <div className={styles.markdownPanel}>
      {page.content.body.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  )
}

/**
 * Inner component — wraps the plugin's React component in a
 * `PluginContext.Provider` so hooks like `usePluginSettings`,
 * `usePluginRoutes`, and `usePluginContext` resolve to this plugin's
 * scoped values.
 */
function PluginReactSubtree({
  Component,
  page,
}: {
  Component: PluginAdminAppComponent
  page: AppPluginPageRoute
}) {
  const contextValue: PluginContextValue = {
    pluginId: page.pluginId,
    pluginVersion: page.pluginVersion,
    surfaceId: page.id,
    surfaceLabel: page.title,
    grantedPermissions: page.pluginGrantedPermissions,
    settings: page.pluginSettings,
    routes: buildPluginRoutesHelper(page.pluginId),
    runCommand: (commandId) => pluginRuntime.runCommand(commandId),
  }

  return (
    <PluginContext.Provider value={contextValue}>
      <Component page={page} />
    </PluginContext.Provider>
  )
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'react'; Component: PluginAdminAppComponent }
  | { kind: 'error'; message: string }

function PluginAppPage({
  page,
  importModule,
}: {
  page: AppPluginPageRoute
  importModule?: PluginAdminAppImport
}) {
  // Track the page identity that produced the current `loadState`. When
  // the page changes (different plugin or different page id), the next
  // render emits `loading` immediately while the effect below imports
  // the new plugin module. Threading a `key` through state means we can
  // discard the stale `loaded` payload if a new page arrived first,
  // without doing a `setState` inside useEffect's body (cascade renders).
  const pageKey = `${page.pluginId}:${page.id}`
  const [loadState, setLoadState] = useState<LoadState & { key?: string }>({
    kind: 'loading',
    key: pageKey,
  })
  const visibleState: LoadState = loadState.key === pageKey
    ? loadState
    : { kind: 'loading' }

  useEffect(() => {
    let cancelled = false
    const cacheKey = pluginCacheKey({
      version: page.pluginVersion,
      updatedAt: page.pluginUpdatedAt,
    })
    // `ensurePluginRuntime` MUST resolve before the plugin module is
    // dynamically imported — the plugin's bundle does `import * as React
    // from 'react'`, which the import-map shims at `/runtime/*.js`
    // resolve via `globalThis.__instatic`. Without the runtime
    // installed, the shims throw at module-evaluation time.
    void ensurePluginRuntime()
      .then(() => loadPluginAdminAppComponent(page, importModule, cacheKey))
      .then((loaded) => {
        if (cancelled) return
        setLoadState({ kind: 'react', Component: loaded.Component, key: pageKey })
      })
      .catch((err) => {
        if (cancelled) return
        setLoadState({
          kind: 'error',
          message: getErrorMessage(err, 'Could not load plugin app'),
          key: pageKey,
        })
      })
    return () => { cancelled = true }
  }, [importModule, page, pageKey])

  return (
    <>
      {visibleState.kind === 'loading' && (
        // Universal three-bar skeleton — same visual as every other
        // loading region in the editor (dashboard widgets, dialogs,
        // page bodies). Plugin apps that take longer to load read
        // identically to the host's own loading surfaces.
        <SkeletonBlock minHeight={240} ariaLabel="Loading plugin app" />
      )}
      {visibleState.kind === 'error' && (
        <p className={styles.error} role="alert">{visibleState.message}</p>
      )}
      {visibleState.kind === 'react' && (
        <PluginReactSubtree Component={visibleState.Component} page={page} />
      )}
    </>
  )
}

function emptyForm(resource: PluginResource | null): Record<string, string | boolean> {
  if (!resource) return {}
  return Object.fromEntries(resource.fields.map((field) => [
    field.id,
    field.type === 'boolean' ? false : '',
  ]))
}

function recordValue(record: PluginRecord, field: PluginResourceField): string {
  const value = record.data[field.id]
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (value === undefined || value === null) return ''
  return String(value)
}

function PluginResourcePage({ page }: { page: ResourcePluginPageRoute }) {
  const [resource, setResource] = useState<PluginResource | null>(null)
  const [records, setRecords] = useState<PluginRecord[]>([])
  const [formData, setFormData] = useState<Record<string, string | boolean>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadPluginResource(
      page.pluginId,
      page.content.resource,
      () => cancelled,
      setLoading,
      setError,
      setResource,
      setRecords,
      setFormData,
    )
    return () => { cancelled = true }
  }, [page.content.resource, page.pluginId])

  function readFormRecord(): Record<string, unknown> {
    if (!resource) return {}
    const data: Record<string, unknown> = {}
    for (const field of resource.fields) {
      const value = formData[field.id]
      if (field.type === 'boolean') {
        data[field.id] = Boolean(value)
        continue
      }
      if (typeof value !== 'string' || !value.trim()) continue
      if (field.type === 'number') {
        data[field.id] = Number(value)
      } else {
        data[field.id] = value.trim()
      }
    }
    return data
  }

  async function createRecord() {
    if (!resource) return
    await createPluginRecord(
      page.pluginId,
      resource,
      readFormRecord(),
      setSaving,
      setError,
      setRecords,
      setFormData,
    )
  }

  async function deleteRecord(record: PluginRecord) {
    if (!resource) return
    await deletePluginRecord(page.pluginId, resource.id, record.id, setError, setRecords)
  }

  return (
    <>
      {loading ? (
        // Skeleton for the resource records page — a form-block + a few
        // record rows. Same layout the loaded page renders.
        <div
          className={styles.resourceLayout}
          aria-busy="true"
          aria-label="Loading records"
        >
          <div className={styles.resourceForm}>
            <SkeletonBlock minHeight={200} />
          </div>
          <div className={styles.resourceRecords}>
            <SkeletonRows count={3} rowHeight={48} />
          </div>
        </div>
      ) : error ? (
        <p className={styles.error} role="alert">{error}</p>
      ) : resource ? (
        <div className={styles.resourceLayout}>
          <form
            className={styles.resourceForm}
            onSubmit={(event) => {
              event.preventDefault()
              void createRecord()
            }}
          >
            <h2>New {resource.singularLabel ?? resource.title}</h2>
            {resource.fields.map((field) => (
              <label key={field.id} className={styles.resourceField}>
                <span>{field.label}</span>
                {field.type === 'longtext' ? (
                  <textarea
                    value={String(formData[field.id] ?? '')}
                    required={field.required}
                    onChange={(event) => setFormData((current) => ({
                      ...current,
                      [field.id]: event.target.value,
                    }))}
                  />
                ) : field.type === 'boolean' ? (
                  <Checkbox
                    checked={Boolean(formData[field.id])}
                    onCheckedChange={(next) => setFormData((current) => ({
                      ...current,
                      [field.id]: next,
                    }))}
                  />
                ) : (
                  <input
                    type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                    value={String(formData[field.id] ?? '')}
                    required={field.required}
                    onChange={(event) => setFormData((current) => ({
                      ...current,
                      [field.id]: event.target.value,
                    }))}
                  />
                )}
              </label>
            ))}
            <Button variant="primary" size="sm" type="submit" disabled={saving}>
              <span>{saving ? 'Creating' : `Create ${resource.singularLabel ?? resource.title}`}</span>
            </Button>
          </form>

          <div className={styles.resourceRecords} aria-label={`${resource.title} records`}>
            {records.length === 0 ? (
              <p className={styles.emptyState}>No records yet.</p>
            ) : records.map((record) => (
              <article key={record.id} className={styles.resourceRecord}>
                <dl>
                  {resource.fields.map((field) => (
                    <div key={field.id}>
                      <dt>{field.label}</dt>
                      <dd>{recordValue(record, field) || '-'}</dd>
                    </div>
                  ))}
                </dl>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void deleteRecord(record)}
                  aria-label={`Delete ${recordValue(record, resource.fields[0]) || record.id}`}
                >
                  <span>Delete</span>
                </Button>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <p className={styles.emptyState}>Plugin resource unavailable.</p>
      )}
    </>
  )
}
