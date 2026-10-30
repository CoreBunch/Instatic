/** Per-surface model defaults in the shared AI master-detail workspace. */
import { useEffect, useRef, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { ModelPicker, type ModelChoice } from '@admin/ai/ModelPicker'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  type AiDefaults,
  type CredentialView,
  clearDefault,
  listCredentials,
  listDefaults,
  setDefault,
} from '../../../ai/api'
import { AiSettingsListSection } from '../AiSettingsListSection'
import { ProviderMark } from '../ProviderMark'
import styles from '../AiPage.module.css'

type ToolScope = 'site' | 'content' | 'data' | 'plugin'

const SCOPES: ToolScope[] = ['site', 'content', 'data', 'plugin']
const SCOPE_META: Record<ToolScope, {
  label: string
  description: string
  icon: typeof LayoutSolidIcon
}> = {
  site: {
    label: 'Site editor',
    description: 'Visual editor chat and page-building tools.',
    icon: LayoutSolidIcon,
  },
  content: {
    label: 'Content',
    description: 'Writing, editing, and structured content workflows.',
    icon: FileTextSolidIcon,
  },
  data: {
    label: 'Data',
    description: 'Data workspace assistance and table operations.',
    icon: DatabaseSolidIcon,
  },
  plugin: {
    label: 'Plugins',
    description: 'AI calls made through the plugin API.',
    icon: CodeIcon,
  },
}

export function DefaultsTab({
  onNavigateToProviders,
}: {
  onNavigateToProviders: () => void
}) {
  const { data, loading, error } = useAsyncResource(
    () => Promise.all([listCredentials(), listDefaults()]).then(([creds, defs]) => ({ creds, defs })),
    [],
    { fallbackError: 'Failed to load defaults.' },
  )
  const credentials: CredentialView[] = data?.creds ?? []
  const [defaults, setDefaults] = useState<AiDefaults>({})
  const [seededDefaults, setSeededDefaults] = useState<AiDefaults | null>(null)
  if (data && data.defs !== seededDefaults) {
    setSeededDefaults(data.defs)
    setDefaults(data.defs)
  }
  const [selectedScope, setSelectedScope] = useState<ToolScope>('site')
  const [saving, setSaving] = useState(false)
  const [clearingScope, setClearingScope] = useState<ToolScope | null>(null)
  const [overrides, setOverrides] = useState<Partial<Record<ToolScope, ModelChoice>>>({})
  const operationInFlight = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Scopes whose override differs from the persisted value. */
  function getDirtyScopes(): ToolScope[] {
    return SCOPES.filter((scope) => {
      const override = overrides[scope]
      if (!override) return false
      const current = defaults[scope]
      return override.credentialId !== current?.credentialId || override.modelId !== current?.modelId
    })
  }

  const dirtyScopes = getDirtyScopes()
  const busy = saving || clearingScope != null
  const canSave = !busy && dirtyScopes.length > 0

  async function handleSaveAll() {
    if (operationInFlight.current) return
    const toSave = getDirtyScopes()
    if (toSave.length === 0) return
    const submitted = toSave.map((scope) => ({ scope, choice: overrides[scope]! }))
    operationInFlight.current = true
    setSaving(true)
    try {
      const results = await Promise.allSettled(
        submitted.map(({ scope, choice }) => {
          return setDefault(scope, { credentialId: choice.credentialId, modelId: choice.modelId })
        }),
      )
      if (!mounted.current) return

      const succeeded: Array<{ scope: ToolScope; choice: ModelChoice }> = []
      const failed: Array<{ scope: ToolScope; error: unknown }> = []
      results.forEach((result, index) => {
        const entry = submitted[index]!
        if (result.status === 'fulfilled') {
          succeeded.push(entry)
        } else {
          failed.push({ scope: entry.scope, error: result.reason })
        }
      })

      setDefaults((previous) => {
        const next = { ...previous }
        for (const { scope, choice } of succeeded) next[scope] = choice
        return next
      })
      setOverrides((previous) => {
        const next = { ...previous }
        for (const { scope, choice } of succeeded) {
          const latest = next[scope]
          if (latest?.credentialId === choice.credentialId && latest.modelId === choice.modelId) {
            delete next[scope]
          }
        }
        return next
      })

      if (failed.length === 0) {
        pushToast({ kind: 'success', title: 'Defaults saved' })
      } else if (succeeded.length === 0) {
        const label = toSave.length === 1
          ? SCOPE_META[toSave[0]!].label
          : `${toSave.length} defaults`
        pushToast({
          kind: 'error',
          title: `Could not save ${label}`,
          body: getErrorMessage(failed[0]!.error, 'Unknown AI default error'),
        })
      } else {
        const failedLabels = failed.map((f) => SCOPE_META[f.scope].label).join(', ')
        pushToast({
          kind: 'error',
          title: 'Some defaults could not be saved',
          body: `Failed: ${failedLabels}. ${getErrorMessage(failed[0]!.error, 'Unknown AI default error')}`,
        })
      }
    } finally {
      operationInFlight.current = false
      if (mounted.current) setSaving(false)
    }
  }

  async function handleClear(scope: ToolScope): Promise<boolean> {
    if (operationInFlight.current) return false
    operationInFlight.current = true
    setClearingScope(scope)
    try {
      await clearDefault(scope)
      if (!mounted.current) return false
      setDefaults((previous) => {
        const next = { ...previous }
        delete next[scope]
        return next
      })
      setOverrides((prev) => {
        const next = { ...prev }
        delete next[scope]
        return next
      })
      pushToast({ kind: 'success', title: `${SCOPE_META[scope].label} default cleared` })
      return true
    } catch (err) {
      if (!mounted.current) return false
      pushToast({
        kind: 'error',
        title: `Could not clear ${SCOPE_META[scope].label} default`,
        body: getErrorMessage(err, 'Unknown AI default error'),
      })
      return false
    } finally {
      operationInFlight.current = false
      if (mounted.current) setClearingScope(null)
    }
  }

  function handleOverrideChange(scope: ToolScope, choice: ModelChoice) {
    setOverrides((prev) => ({ ...prev, [scope]: choice }))
  }

  return (
    <section className={styles.settingsWorkspace} aria-labelledby="defaults-heading">
      <aside className={styles.settingsBrowser} aria-label="Default model settings">
        <div className={styles.settingsBrowserHeader}>
          <h2 id="defaults-heading">Defaults</h2>
        </div>

        <div className={styles.settingsBrowserSections}>
          <AiSettingsListSection label="Model routing">
            {SCOPES.map((scope) => {
              const meta = SCOPE_META[scope]
              const Icon = meta.icon
              const active = selectedScope === scope
              const hasPending = overrides[scope] != null
                && (overrides[scope]!.credentialId !== defaults[scope]?.credentialId
                  || overrides[scope]!.modelId !== defaults[scope]?.modelId)
              return (
                <Button
                  key={scope}
                  type="button"
                  variant="ghost"
                  size="md"
                  fullWidth
                  active={active}
                  align="start"
                  className={styles.settingsListItem}
                  onClick={() => setSelectedScope(scope)}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className={styles.settingsItemIcon} aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span className={styles.settingsListIdentity}>
                    <span className={styles.settingsListLabel}>
                      {meta.label}
                      {hasPending && <span className={styles.pendingDot} aria-label="unsaved changes" />}
                    </span>
                    <span className={styles.settingsListMeta}>
                      {defaults[scope]?.modelId ?? 'Not configured'}
                    </span>
                  </span>
                  {!active && <ArrowRightIcon size={13} aria-hidden="true" />}
                </Button>
              )
            })}
          </AiSettingsListSection>
        </div>
      </aside>

      <div className={styles.settingsDetailCanvas}>
        {loading ? (
          <div className={styles.emptyState}>Loading defaults…</div>
        ) : error ? (
          <p role="alert" className={styles.errorAlert}>{error}</p>
        ) : (
          <ScopeDetail
            scope={selectedScope}
            credentials={credentials}
            current={defaults[selectedScope]}
            override={overrides[selectedScope] ?? null}
            onOverrideChange={(choice) => handleOverrideChange(selectedScope, choice)}
            busy={busy}
            saving={saving}
            canSave={canSave}
            dirtyCount={dirtyScopes.length}
            onNavigateToProviders={onNavigateToProviders}
            onSave={handleSaveAll}
            onClear={() => handleClear(selectedScope)}
          />
        )}
      </div>
    </section>
  )
}

function ScopeDetail({
  scope,
  credentials,
  current,
  override,
  onOverrideChange,
  busy,
  saving,
  canSave,
  dirtyCount,
  onNavigateToProviders,
  onSave,
  onClear,
}: {
  scope: ToolScope
  credentials: CredentialView[]
  current: { credentialId: string; modelId: string } | undefined
  override: ModelChoice | null
  onOverrideChange: (choice: ModelChoice) => void
  busy: boolean
  saving: boolean
  canSave: boolean
  dirtyCount: number
  onNavigateToProviders: () => void
  onSave: () => Promise<void>
  onClear: () => Promise<boolean>
}) {
  const meta = SCOPE_META[scope]
  const Icon = meta.icon
  const savedCredential = current
    ? credentials.find((credential) => credential.id === current.credentialId)
    : undefined
  const savedResolves = Boolean(savedCredential)
  const value: ModelChoice | null = override
    ?? (current && savedResolves
      ? { credentialId: current.credentialId, modelId: current.modelId }
      : null)
  const stale = Boolean(current?.credentialId) && !savedResolves
  const canClear = !busy && current != null

  return (
    <article className={styles.settingsDetail} aria-labelledby="default-scope-title">
      <header className={styles.settingsDetailHeader}>
        <span className={styles.settingsHeroIcon} aria-hidden="true">
          <Icon size={22} />
        </span>
        <div className={styles.settingsDetailIdentity}>
          <span className={styles.detailEyebrow}>Model routing</span>
          <h2 id="default-scope-title">{meta.label}</h2>
          <p>{meta.description}</p>
        </div>
      </header>

      <section className={styles.settingsDetailSection}>
        <div className={styles.detailSectionHeader}>
          <div>
            <h3>Default model</h3>
            <p>Users can still choose another available model for an individual conversation.</p>
          </div>
        </div>

        {credentials.length === 0 ? (
          <div className={styles.defaultsSetupEmpty}>
            <div>
              <h3>Connect a provider first</h3>
              <p>Model routing becomes available after at least one credential is ready.</p>
            </div>
            <Button type="button" variant="primary" size="md" onClick={onNavigateToProviders}>
              Go to Providers
            </Button>
          </div>
        ) : (
          <>
            <div className={styles.settingsFormRow}>
              <label>Credential and model</label>
              <div>
                <ModelPicker
                  variant="field"
                  ariaLabel={`Model for ${meta.label}`}
                  placeholder="Choose credential and model"
                  credentials={credentials}
                  credentialsLoaded
                  disabled={busy}
                  value={value}
                  onChange={onOverrideChange}
                />
                {savedCredential && current && (
                  <span className={styles.defaultCurrentChoice}>
                    <ProviderMark providerId={savedCredential.providerId} size="sm" />
                    Current: {savedCredential.displayLabel} · {current.modelId}
                  </span>
                )}
                {stale && (
                  <p role="status" className={styles.defaultStaleMessage}>
                    The saved credential is no longer available. Choose a replacement.
                  </p>
                )}
              </div>
            </div>

            <div className={styles.settingsDetailActions}>
              {current && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canClear}
                  onClick={() => { void onClear() }}
                >
                  <CloseIcon size={12} aria-hidden="true" />
                  <span>Clear</span>
                </Button>
              )}
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!canSave}
                onClick={() => { void onSave() }}
              >
                <SaveSolidIcon size={13} aria-hidden="true" />
                <span>{saving ? 'Saving…' : dirtyCount > 1 ? `Save ${dirtyCount} defaults` : 'Save default'}</span>
              </Button>
            </div>
          </>
        )}
      </section>
    </article>
  )
}
