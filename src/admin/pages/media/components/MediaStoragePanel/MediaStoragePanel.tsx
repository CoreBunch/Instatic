import { getActiveAdminLocale } from "@admin/i18n"
/**
 * MediaStoragePanel — Media sidebar panel for storage configuration.
 *
 *   • Elect the storage adapter that handles each asset role (original /
 *     variant / avatar / font / plugin-pack). Plugins ship adapters
 *     (S3, R2, GCS, …); the built-in local-disk adapter is always
 *     available as the fallback.
 *   • Pick a variant delegate (Cloudflare Images / Imgix / Bunny
 *     Optimizer) so the host skips local sharp resizing and emits
 *     URL-template-derived variants instead.
 *   • Run an adapter's `verify()` to test credentials BEFORE relying
 *     on it for uploads.
 *
 * Reads + writes go through `@core/persistence/cmsMediaStorage`, which
 * talks to `server/handlers/cms/mediaStorageAdmin.ts`. The endpoints
 * are gated by `storage.elect`; the sidebar's rail button is hidden
 * for users without that capability.
 *
 * Sits inside the `Panel` shell with `body="padded"` so it inherits
 * the editor's standard panel chrome (header bar + close button +
 * 8px padded scroll area). Each role / adapter is its own surface-2
 * card — same borderless-tile vibe as the dashboard widgets.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { SkeletonBlock } from '@ui/components/Skeleton'
import type { MediaAssetRole, MediaStorageVerifyResult } from '@core/plugin-sdk'
import {
  electCmsMediaAdapter,
  electCmsMediaVariantDelegate,
  getCmsMediaStorageState,
  startCmsMediaMigration,
  verifyCmsMediaAdapter,
  type CmsMediaAdapterSummary,
  type CmsMediaElection,
  type CmsMediaMigrationEvent,
  type CmsMediaStorageState,
  type CmsMediaVariantDelegateSummary,
  type CmsMediaElectedVariantDelegate,
  type MigrationRole,
} from '@core/persistence/cmsMediaStorage'
import styles from './MediaStoragePanel.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

const ROLE_HINTS: Record<MediaAssetRole, string> = {
  original: 'Originals uploaded via the Media library and the editor.',
  variant: 'Responsive WebP variants generated for every image.',
  avatar: 'User profile photos from the Account page.',
  font: 'Self-hosted webfont files installed via the Fonts panel.',
  'plugin-pack': 'Plugin-shipped static assets (icons, frontend bundles).',
}

const ROLE_LABELS: Record<MediaAssetRole, string> = {
  original: 'Originals',
  variant: 'Variants',
  avatar: 'Avatars',
  font: 'Fonts',
  'plugin-pack': 'Plugin assets',
}

const LOCAL_DISK_LABEL = 'Local disk (built-in)'
const LOCAL_DELEGATE_LABEL = 'Local sharp ladder (built-in)'

function buildAdapterOptions(
  role: MediaAssetRole,
  adapters: ReadonlyArray<CmsMediaAdapterSummary>,
): Array<{ value: string; label: string }> {
  const opts: Array<{ value: string; label: string }> = [
    { value: '', label: LOCAL_DISK_LABEL },
  ]
  for (const adapter of adapters) {
    if (adapter.isBuiltIn) continue
    if (!adapter.roles.includes(role)) continue
    opts.push({ value: adapter.id, label: adapter.label })
  }
  return opts
}

interface VerifyState {
  loading: boolean
  result: MediaStorageVerifyResult | null
}

/**
 * UI state for an in-flight migration. `kind: 'idle'` covers both
 * "haven't started yet" and "finished — show the summary". The
 * `summary` lives on the running and done states because the user
 * can keep watching the panel after a run completes.
 */
type MigrationState =
  | { kind: 'idle' }
  | { kind: 'running'; role: MigrationRole; migrated: number; failed: number; total: number; lastError: string | null }
  | { kind: 'done'; role: MigrationRole; migrated: number; failed: number; total: number }
  | { kind: 'failed'; role: MigrationRole; message: string }

// Module-level helpers — extracted so the React Compiler can compile the
// component body (it bails on try/catch/finally inside component/hook bodies).

async function runElect(
  role: MediaAssetRole,
  adapterId: string,
  electFn: typeof electCmsMediaAdapter,
  reload: () => Promise<void>,
  setError: (err: string | null) => void,
  setPendingElection: (role: MediaAssetRole | null) => void,
): Promise<void> {
  try {
    await electFn({ role, adapterId })
    await reload()
  } catch (err) {
    setError(getErrorMessage(err, 'Failed to elect adapter'))
  } finally {
    setPendingElection(null)
  }
}

async function runDelegate(
  delegateId: string | null,
  delegateFn: typeof electCmsMediaVariantDelegate,
  reload: () => Promise<void>,
  setError: (err: string | null) => void,
  setPendingDelegate: (v: boolean) => void,
): Promise<void> {
  try {
    await delegateFn({ delegateId })
    await reload()
  } catch (err) {
    setError(getErrorMessage(err, 'Failed to update variant delegate'))
  } finally {
    setPendingDelegate(false)
  }
}

export function MediaStoragePanel() {
  const [state, setState] = useState<CmsMediaStorageState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pendingElection, setPendingElection] = useState<MediaAssetRole | null>(null)
  const [pendingDelegate, setPendingDelegate] = useState(false)
  const [verify, setVerify] = useState<Record<string, VerifyState>>({})
  const [migration, setMigration] = useState<MigrationState>({ kind: 'idle' })
  // The cancel handle for the in-flight migration. We stash it in a ref
  // (not state) because the SSE iterator captures it once at start time
  // and a re-render that drops a fresh handle into state wouldn't reach
  // the running loop.
  const migrationCancelRef = useRef<(() => void) | null>(null)

  // useCallback kept: stable identity for the [reload] useEffect dep array (exhaustive-deps).
  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setState(await getCmsMediaStorageState())
    } catch (err) {
      setError(getErrorMessage(err, 'Unknown error'))
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch. The `reload` callback flips `loading` synchronously
  // (which the rule normally flags), but a one-shot data-fetch effect
  // is exactly the case React's "you might not need an effect" docs
  // call out as legitimate — there's no parent prop to derive from, the
  // panel owns the request lifecycle itself.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void reload()
  }, [reload])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleElect = async (role: MediaAssetRole, adapterId: string) => {
    setPendingElection(role)
    setError(null)
    await runElect(role, adapterId, electCmsMediaAdapter, reload, setError, setPendingElection)
  }

  const handleDelegate = async (delegateId: string | null) => {
    setPendingDelegate(true)
    setError(null)
    await runDelegate(delegateId, electCmsMediaVariantDelegate, reload, setError, setPendingDelegate)
  }

  const handleVerify = async (adapterId: string) => {
    setVerify((prev) => ({ ...prev, [adapterId]: { loading: true, result: null } }))
    try {
      const result = await verifyCmsMediaAdapter(adapterId)
      setVerify((prev) => ({ ...prev, [adapterId]: { loading: false, result } }))
    } catch (err) {
      const message = getErrorMessage(err, 'Verify request failed')
      setVerify((prev) => ({
        ...prev,
        [adapterId]: { loading: false, result: { ok: false, reason: message } },
      }))
    }
  }

  /**
   * Start a migration for `role`, streaming progress into the
   * `migration` state. The target adapter is whatever's currently
   * elected for that role (the server enforces this too).
   *
   * If a migration is already running, we no-op — the button is
   * disabled in that state, but defending against double-clicks here
   * keeps the SSE state machine honest.
   */
  const handleMigrate = async (role: MigrationRole) => {
    if (migration.kind === 'running') return
    if (!state) return
    const target = state.elections.find((e) => e.role === role)?.adapterId ?? ''
    setError(null)
    setMigration({ kind: 'running', role, migrated: 0, failed: 0, total: 0, lastError: null })
    try {
      const { events, cancel } = await startCmsMediaMigration({ role, toAdapterId: target })
      migrationCancelRef.current = cancel
      let finalEvent: CmsMediaMigrationEvent | null = null
      for await (const event of events) {
        finalEvent = event
        if (event.kind === 'started') {
          setMigration({ kind: 'running', role, migrated: 0, failed: 0, total: event.total, lastError: null })
        } else if (event.kind === 'progress') {
          setMigration((prev) => prev.kind === 'running'
            ? {
              ...prev,
              migrated: event.migrated,
              failed: prev.failed + (event.ok ? 0 : 1),
              total: event.total,
              lastError: event.ok ? prev.lastError : (event.error ?? 'Unknown error'),
            }
            : prev,
          )
        } else if (event.kind === 'done') {
          setMigration({
            kind: 'done',
            role,
            migrated: event.migrated,
            failed: event.failed,
            total: event.total,
          })
        } else if (event.kind === 'error') {
          setMigration({ kind: 'failed', role, message: event.message })
        }
      }
      if (!finalEvent) {
        // Server closed the stream without sending any frames. Surface
        // it as a generic failure so the UI doesn't get stuck in
        // 'running' forever.
        setMigration({ kind: 'failed', role, message: 'Server closed the migration stream without progress.' })
      }
    } catch (err) {
      const message = getErrorMessage(err, 'Migration request failed')
      setMigration({ kind: 'failed', role, message })
    } finally {
      migrationCancelRef.current = null
      // Refresh the state so the backlog count + asset counts update.
      void reload()
    }
  }

  const handleCancelMigration = () => {
    migrationCancelRef.current?.()
  }

  if (loading && !state) {
    return (
      <div className={styles.root}>
        <SkeletonBlock minHeight={160} ariaLabel="Loading media storage" />
      </div>
    )
  }

  return (
    <div className={styles.root}>
      {error && (
        <div className={styles.errorBanner} role="alert">{error}</div>
      )}

      {state && (
        <>
          <RoleSection
            state={state}
            pendingElection={pendingElection}
            onElect={handleElect}
            migration={migration}
            onMigrate={handleMigrate}
            onCancelMigration={handleCancelMigration}
          />
          <DelegateSection
            state={state}
            pendingDelegate={pendingDelegate}
            onChange={handleDelegate}
          />
          <AdaptersSection
            state={state}
            verify={verify}
            onVerify={handleVerify}
          />
        </>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────

function RoleSection({
  state,
  pendingElection,
  onElect,
  migration,
  onMigrate,
  onCancelMigration,
}: {
  state: CmsMediaStorageState
  pendingElection: MediaAssetRole | null
  onElect: (role: MediaAssetRole, adapterId: string) => void | Promise<void>
  migration: MigrationState
  onMigrate: (role: MigrationRole) => void | Promise<void>
  onCancelMigration: () => void
}) {
  const byRole = new Map<MediaAssetRole, CmsMediaElection>()
  for (const election of state.elections) byRole.set(election.role, election)

  return (
    <section className={styles.section} aria-labelledby="media-storage-roles">
      <h3 id="media-storage-roles" className={styles.sectionLabel}>
        Backend per role
      </h3>
      <p className={styles.sectionDescription}>
        Reads dispatch through the adapter that wrote each asset, so changing the
        elected backend never strands existing rows.
      </p>
      <div className={styles.rows}>
        {state.roles.map((role) => {
          const election = byRole.get(role)
          const adapterId = election?.adapterId ?? ''
          const installed = election?.installed ?? true
          const assetCount = election?.assetCount ?? 0
          const options = buildAdapterOptions(role, state.adapters)
          // Migration backlog is only computed for 'original' / 'variant'
          // in v1; the UI surfaces the Migrate button under those rows
          // only when at least one asset is on a non-target adapter.
          const isMigratableRole = role === 'original' || role === 'variant'
          const backlog = isMigratableRole
            ? state.migrationBacklog[role as 'original' | 'variant']
            : 0
          const rowMigration = isMigratableRole && migration.kind !== 'idle' && migration.role === role
            ? migration
            : null
          return (
            <div key={role} className={styles.row}>
              <div className={styles.rowHead}>
                <span className={styles.rowLabel}>{ROLE_LABELS[role]}</span>
                <span className={styles.rowMeta}>
                  {assetCount.toLocaleString(getActiveAdminLocale())} asset{assetCount === 1 ? '' : 's'}
                </span>
              </div>
              <Select
                className={styles.rowSelect}
                value={adapterId}
                options={options}
                aria-label={`Storage adapter for ${ROLE_LABELS[role]}`}
                disabled={pendingElection === role || migration.kind === 'running'}
                onChange={(e) => onElect(role, e.target.value)}
              />
              {!installed && adapterId !== '' ? (
                <p className={styles.statusBad}>
                  Adapter “{adapterId}” is no longer installed. Re-elect to keep new uploads working.
                </p>
              ) : (
                <p className={styles.rowHint}>{ROLE_HINTS[role]}</p>
              )}
              {isMigratableRole && (
                <MigrationAffordance
                  role={role as MigrationRole}
                  backlog={backlog}
                  migration={rowMigration}
                  // Disable migrate while another role's migration is running.
                  otherMigrationRunning={
                    migration.kind === 'running' && migration.role !== role
                  }
                  onMigrate={onMigrate}
                  onCancel={onCancelMigration}
                />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Affordance for moving existing assets to the currently-elected adapter
 * for a role. Three states:
 *
 *   - Idle, no backlog: nothing to show (collapsed).
 *   - Idle, backlog > 0: render the "Migrate N pending →" button.
 *   - Running: progress text + Cancel button.
 *   - Done / failed: terminal summary line.
 *
 * The 'running' state can apply to ANY role; we only render the local
 * progress when the running migration matches the row's role
 * (everything else gets the muted "migration in progress" disabled
 * state via `otherMigrationRunning`).
 */
function MigrationAffordance({
  role,
  backlog,
  migration,
  otherMigrationRunning,
  onMigrate,
  onCancel,
}: {
  role: MigrationRole
  backlog: number
  migration: MigrationState | null
  otherMigrationRunning: boolean
  onMigrate: (role: MigrationRole) => void | Promise<void>
  onCancel: () => void
}) {
  // Terminal states: render the summary, then offer "Migrate" again if
  // any backlog remains (e.g. a retry after partial failure).
  if (migration?.kind === 'done') {
    const failedNote = migration.failed > 0
      ? `, ${migration.failed.toLocaleString(getActiveAdminLocale())} failed`
      : ''
    return (
      <div className={styles.migration}>
        <span className={styles.statusGood}>
          Migrated {migration.migrated.toLocaleString(getActiveAdminLocale())} / {migration.total.toLocaleString(getActiveAdminLocale())}{failedNote}.
        </span>
        {backlog > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onMigrate(role)}
            disabled={otherMigrationRunning}
          >
            Retry · {backlog.toLocaleString(getActiveAdminLocale())} pending
          </Button>
        )}
      </div>
    )
  }
  if (migration?.kind === 'failed') {
    return (
      <div className={styles.migration}>
        <span className={styles.statusBad}>Migration failed: {migration.message}</span>
        {backlog > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onMigrate(role)}
            disabled={otherMigrationRunning}
          >
            Retry
          </Button>
        )}
      </div>
    )
  }
  if (migration?.kind === 'running') {
    const ratio = migration.total > 0 ? Math.round((migration.migrated / migration.total) * 100) : 0
    return (
      <div className={styles.migration}>
        <span className={styles.migrationProgress}>
          Migrating… {migration.migrated.toLocaleString(getActiveAdminLocale())} / {migration.total.toLocaleString(getActiveAdminLocale())} ({ratio}%)
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        {migration.lastError && (
          <span className={styles.statusBad}>Last error: {migration.lastError}</span>
        )}
      </div>
    )
  }

  // Idle — show the affordance only when there's something to migrate.
  if (backlog <= 0) return null
  return (
    <div className={styles.migration}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onMigrate(role)}
        disabled={otherMigrationRunning}
      >
        Migrate {backlog.toLocaleString(getActiveAdminLocale())} pending →
      </Button>
      <span className={styles.rowHint}>
        Move existing {role === 'variant' ? 'variants' : 'originals'} to the elected backend.
      </span>
    </div>
  )
}

function DelegateSection({
  state,
  pendingDelegate,
  onChange,
}: {
  state: CmsMediaStorageState
  pendingDelegate: boolean
  onChange: (delegateId: string | null) => void | Promise<void>
}) {
  const delegateOptions: Array<{ value: string; label: string }> = [
    { value: '', label: LOCAL_DELEGATE_LABEL },
    ...state.delegates.map((d) => ({ value: d.id, label: d.id })),
  ]
  const elected = state.electedDelegate
  const electedRecord: CmsMediaVariantDelegateSummary | CmsMediaElectedVariantDelegate | null = elected
    ? (state.delegates.find((d) => d.id === elected.delegateId) ?? elected)
    : null
  const template = electedRecord && 'variantUrlTemplate' in electedRecord
    ? electedRecord.variantUrlTemplate
    : null

  return (
    <section className={styles.section} aria-labelledby="media-storage-delegate">
      <h3 id="media-storage-delegate" className={styles.sectionLabel}>
        Variant delegate
      </h3>
      <p className={styles.sectionDescription}>
        When elected, the host skips local image resizing and emits responsive
        variant URLs from the delegate's template.
      </p>
      <div className={styles.rows}>
        <div className={styles.row}>
          <Select
            className={styles.rowSelect}
            value={elected?.delegateId ?? ''}
            options={delegateOptions}
            aria-label="Variant delegate"
            disabled={pendingDelegate}
            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          />
          {template ? (
            <div className={styles.delegateTemplate}>{template}</div>
          ) : (
            <p className={styles.rowHint}>
              {state.delegates.length === 0
                ? 'No variant delegate plugins installed yet.'
                : `${state.delegates.length} installed delegate${state.delegates.length === 1 ? '' : 's'} — pick one to take over variant generation.`}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function AdaptersSection({
  state,
  verify,
  onVerify,
}: {
  state: CmsMediaStorageState
  verify: Record<string, VerifyState>
  onVerify: (adapterId: string) => void | Promise<void>
}) {
  const external = state.adapters.filter((a) => !a.isBuiltIn)

  return (
    <section className={styles.section} aria-labelledby="media-storage-adapters">
      <h3 id="media-storage-adapters" className={styles.sectionLabel}>
        Installed adapters
      </h3>
      {external.length === 0 ? (
        <p className={styles.empty}>
          No external storage adapters installed. The built-in local-disk adapter
          handles every role until a plugin (S3, R2, …) is installed.
        </p>
      ) : (
        <div className={styles.rows}>
          {external.map((adapter) => {
            const v = verify[adapter.id]
            return (
              <div key={adapter.id} className={styles.row}>
                <div className={styles.rowHead}>
                  <span className={styles.rowLabel}>{adapter.label}</span>
                  <span className={styles.badge}>{adapter.servingMode}</span>
                </div>
                <div className={styles.adapterBadges}>
                  {adapter.roles.map((role) => (
                    <span key={role} className={styles.badge}>{ROLE_LABELS[role]}</span>
                  ))}
                </div>
                <div className={styles.adapterMeta}>{adapter.id}</div>
                {adapter.cspOrigins.length > 0 && (
                  <ul className={styles.cspList}>
                    {adapter.cspOrigins.map((entry) => (
                      <li key={`${entry.directive}|${entry.origin}`}>
                        {entry.directive}: {entry.origin}
                      </li>
                    ))}
                  </ul>
                )}
                <div className={styles.adapterActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onVerify(adapter.id)}
                    disabled={v?.loading ?? false}
                  >
                    {v?.loading ? 'Testing…' : 'Test connection'}
                  </Button>
                  {v?.result && (
                    <span
                      className={`${styles.verifyStatus} ${v.result.ok ? styles.statusGood : styles.statusBad}`}
                      role={v.result.ok ? 'status' : 'alert'}
                    >
                      {v.result.ok
                        ? 'OK'
                        : `Failed${v.result.reason ? `: ${v.result.reason}` : ''}${v.result.hint ? ` — ${v.result.hint}` : ''}`}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
