import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import {
  deleteCmsStagingEnvironment,
  getCmsStagingEnvironment,
  refreshCmsStagingEnvironment,
  saveCmsStagingEnvironment,
  testCmsStagingEnvironment,
} from '@core/persistence'
import { listCmsDataTables } from '@core/persistence/cmsData'
import type { DataTableListItem } from '@core/data/schemas'
import type { StagingEnvironment } from '@core/staging'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Input } from '@ui/components/Input'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import s from '../SettingsModal.module.css'

interface StagingResource {
  environment: StagingEnvironment
  tables: DataTableListItem[]
}

export function StagingSection() {
  const resource = useAsyncResource<StagingResource>(
    async (signal) => {
      const [environment, tables] = await Promise.all([
        getCmsStagingEnvironment(signal),
        listCmsDataTables(),
      ])
      return { environment, tables }
    },
    [],
    { fallbackError: 'Failed to load staging settings' },
  )

  if (resource.loading && !resource.data) {
    return <SkeletonBlock minHeight={360} ariaLabel="Loading staging settings" />
  }
  if (resource.error || !resource.data) {
    return <p className={s.sectionDescription} role="alert">{resource.error}</p>
  }

  const environmentKey = [
    resource.data.environment.origin,
    resource.data.environment.lastSyncAt,
  ].join(':')

  return (
    <StagingForm
      key={environmentKey}
      initial={resource.data.environment}
      tables={resource.data.tables}
      onSaved={resource.refresh}
    />
  )
}

function StagingForm({
  initial,
  tables,
  onSaved,
}: {
  initial: StagingEnvironment
  tables: DataTableListItem[]
  onSaved: () => void
}) {
  const { runStepUp } = useStepUp()
  const [origin, setOrigin] = useState(initial.origin ?? '')
  const [token, setToken] = useState('')
  const [includeSite, setIncludeSite] = useState(initial.includeSite)
  const [syncAll, setSyncAll] = useState(initial.tableIds.length === 0)
  const [selectedTableIds, setSelectedTableIds] = useState(() => new Set(initial.tableIds))
  const [busy, setBusy] = useState<'save' | 'test' | 'refresh' | 'delete' | null>(null)

  async function handleSave() {
    if (!syncAll && selectedTableIds.size === 0) {
      pushToast({ kind: 'error', title: 'Choose at least one table' })
      return
    }
    setBusy('save')
    try {
      await runStepUp(() => saveCmsStagingEnvironment({
        origin,
        ...(token ? { token } : {}),
        tableIds: syncAll ? [] : [...selectedTableIds],
        includeSite,
      }))
      setToken('')
      pushToast({ kind: 'success', title: 'Staging configuration saved' })
      onSaved()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      pushToast({
        kind: 'error',
        title: 'Could not save staging configuration',
        body: getErrorMessage(err, 'Unknown staging configuration error'),
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleTest() {
    setBusy('test')
    try {
      await testCmsStagingEnvironment()
      pushToast({ kind: 'success', title: 'Staging connection verified' })
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Staging connection failed',
        body: getErrorMessage(err, 'Unknown connection error'),
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleRefresh() {
    setBusy('refresh')
    try {
      const result = await runStepUp(refreshCmsStagingEnvironment)
      pushToast({
        kind: 'success',
        title: 'Staging refreshed',
        body: `${result.import.rowsInserted} rows synchronized and ${result.publishedPages} pages published.`,
      })
      onSaved()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      pushToast({
        kind: 'error',
        title: 'Staging refresh failed',
        body: getErrorMessage(err, 'Unknown staging refresh error'),
      })
      onSaved()
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete() {
    setBusy('delete')
    try {
      await runStepUp(deleteCmsStagingEnvironment)
      pushToast({ kind: 'success', title: 'Staging environment disconnected' })
      onSaved()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      pushToast({
        kind: 'error',
        title: 'Could not disconnect staging',
        body: getErrorMessage(err, 'Unknown staging configuration error'),
      })
    } finally {
      setBusy(null)
    }
  }

  function toggleTable(tableId: string, checked: boolean) {
    setSelectedTableIds((current) => {
      const next = new Set(current)
      if (checked) next.add(tableId)
      else next.delete(tableId)
      return next
    })
  }

  return (
    <div>
      <p className={s.sectionDescription}>
        Connect a separate Instatic instance and refresh its database without affecting production.
      </p>

      <section aria-labelledby="staging-target-heading" className={s.sectionBlock}>
        <h4 id="staging-target-heading" className={s.subHeading}>Target</h4>
        <div className={s.stagingFields}>
          <label className={s.fieldLabel} htmlFor="staging-origin">Staging origin</label>
          <Input
            id="staging-origin"
            type="url"
            value={origin}
            placeholder="https://staging.example.com"
            onChange={(event) => setOrigin(event.currentTarget.value)}
          />
          <label className={s.fieldLabel} htmlFor="staging-token">Sync token</label>
          <Input
            id="staging-token"
            type="password"
            value={token}
            placeholder={initial.hasToken ? 'Stored securely; enter to replace' : 'Enter STAGING_SYNC_TOKEN'}
            onChange={(event) => setToken(event.currentTarget.value)}
          />
          {!initial.keyFingerprintCurrent && (
            <p className={s.stagingWarning} role="alert">
              The server encryption key changed. Re-enter the sync token before continuing.
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="staging-scope-heading" className={s.sectionBlock}>
        <h4 id="staging-scope-heading" className={s.subHeading}>Refresh scope</h4>
        <div className={s.cardGroup}>
          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor="staging-include-site" className={s.toggleRowLabel}>Site structure and settings</label>
              <p className={s.toggleRowDesc}>Include pages, breakpoints, classes, files, and runtime settings.</p>
            </div>
            <Switch id="staging-include-site" checked={includeSite} onCheckedChange={setIncludeSite} />
          </div>
          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor="staging-all-tables" className={s.toggleRowLabel}>All database tables</label>
              <p className={s.toggleRowDesc}>Replace the complete staging content database on every refresh.</p>
            </div>
            <Switch id="staging-all-tables" checked={syncAll} onCheckedChange={setSyncAll} />
          </div>
        </div>

        {!syncAll && (
          <fieldset className={s.stagingTableList}>
            <legend>Select tables</legend>
            {tables.map((table) => (
              <label key={table.id} className={s.stagingTableRow}>
                <Checkbox
                  checked={selectedTableIds.has(table.id)}
                  onCheckedChange={(checked) => toggleTable(table.id, checked)}
                />
                <span>{table.name}</span>
                <small>{table.rowCount} rows</small>
              </label>
            ))}
          </fieldset>
        )}
      </section>

      {initial.lastSyncAt && (
        <p className={s.stagingStatus} data-status={initial.lastSyncStatus ?? undefined}>
          Last refresh: {new Date(initial.lastSyncAt).toLocaleString()}
          {initial.lastSyncError ? ` - ${initial.lastSyncError}` : ''}
        </p>
      )}

      <div className={s.stagingActions}>
        <Button variant="primary" onClick={() => void handleSave()} disabled={busy !== null || !origin.trim()}>
          {busy === 'save' ? 'Saving...' : 'Save configuration'}
        </Button>
        <Button variant="secondary" onClick={() => void handleTest()} disabled={busy !== null || !initial.configured}>
          {busy === 'test' ? 'Testing...' : 'Test connection'}
        </Button>
        <Button variant="secondary" onClick={() => void handleRefresh()} disabled={busy !== null || !initial.configured || !initial.keyFingerprintCurrent}>
          {busy === 'refresh' ? 'Refreshing...' : 'Refresh staging'}
        </Button>
        {initial.configured && (
          <Button variant="secondary" tone="danger" onClick={() => void handleDelete()} disabled={busy !== null}>
            {busy === 'delete' ? 'Disconnecting...' : 'Disconnect'}
          </Button>
        )}
      </div>
    </div>
  )
}
