/** Per-surface model defaults in the shared AI master-detail workspace. */
import { useState } from 'react'
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
  const { data, loading, error, refresh } = useAsyncResource(
    () => Promise.all([listCredentials(), listDefaults()]).then(([creds, defs]) => ({ creds, defs })),
    [],
    { fallbackError: 'Failed to load defaults.' },
  )
  const credentials: CredentialView[] = data?.creds ?? []
  const defaults: AiDefaults = data?.defs ?? {}
  const [selectedScope, setSelectedScope] = useState<ToolScope>('site')
  const [savingScope, setSavingScope] = useState<ToolScope | null>(null)
  const [statusByScope, setStatusByScope] = useState<Record<string, string>>({})

  async function handleSave(scope: ToolScope, credentialId: string, modelId: string) {
    setSavingScope(scope)
    setStatusByScope((previous) => ({ ...previous, [scope]: '' }))
    try {
      await setDefault(scope, { credentialId, modelId })
      setStatusByScope((previous) => ({ ...previous, [scope]: 'Saved' }))
      refresh()
    } catch (err) {
      pushToast({
        kind: 'error',
        title: `Could not save ${SCOPE_META[scope].label} default`,
        body: getErrorMessage(err, 'Unknown AI default error'),
      })
    } finally {
      setSavingScope(null)
    }
  }

  async function handleClear(scope: ToolScope): Promise<boolean> {
    setSavingScope(scope)
    setStatusByScope((previous) => ({ ...previous, [scope]: '' }))
    try {
      await clearDefault(scope)
      setStatusByScope((previous) => ({ ...previous, [scope]: 'Cleared' }))
      refresh()
      return true
    } catch (err) {
      pushToast({
        kind: 'error',
        title: `Could not clear ${SCOPE_META[scope].label} default`,
        body: getErrorMessage(err, 'Unknown AI default error'),
      })
      return false
    } finally {
      setSavingScope(null)
    }
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
                    <span className={styles.settingsListLabel}>{meta.label}</span>
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
            key={selectedScope}
            scope={selectedScope}
            credentials={credentials}
            current={defaults[selectedScope]}
            busy={savingScope === selectedScope}
            status={statusByScope[selectedScope]}
            onNavigateToProviders={onNavigateToProviders}
            onSave={(credentialId, modelId) => handleSave(selectedScope, credentialId, modelId)}
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
  busy,
  status,
  onNavigateToProviders,
  onSave,
  onClear,
}: {
  scope: ToolScope
  credentials: CredentialView[]
  current: { credentialId: string; modelId: string } | undefined
  busy: boolean
  status: string | undefined
  onNavigateToProviders: () => void
  onSave: (credentialId: string, modelId: string) => Promise<void>
  onClear: () => Promise<boolean>
}) {
  const [override, setOverride] = useState<ModelChoice | null>(null)
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
  const dirty = override != null
    && (override.credentialId !== current?.credentialId || override.modelId !== current?.modelId)
  const canSave = !busy && value != null && dirty
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
                  value={value}
                  onChange={setOverride}
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
                  onClick={() => {
                    void onClear().then((cleared) => {
                      if (cleared) setOverride(null)
                    })
                  }}
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
                onClick={() => value && void onSave(value.credentialId, value.modelId)}
              >
                <SaveSolidIcon size={13} aria-hidden="true" />
                <span>Save default</span>
              </Button>
              {status && <span role="status" className={styles.defaultSaveStatus}>{status}</span>}
            </div>
          </>
        )}
      </section>
    </article>
  )
}
