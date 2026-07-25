/** Provider management in the shared AI master-detail workspace. */
import { useId, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  type AiModel,
  type CreateCredentialBody,
  type CredentialView,
  type TestResult,
  createCredential,
  deleteCredential,
  listCredentials,
  listModels,
  testCredential,
} from '../../../ai/api'
import { ProviderMark } from '../ProviderMark'
import { AiSettingsListSection } from '../AiSettingsListSection'
import {
  PROVIDER_SPECS,
  getProviderSpec,
  type ProviderId,
  type ProviderSpec,
} from '../providerCatalog'
import styles from '../AiPage.module.css'

type Selection =
  | { kind: 'credential'; id: string }
  | { kind: 'provider'; providerId: ProviderId }

const API_KEY_PLACEHOLDER: Partial<Record<ProviderId, string>> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  openrouter: 'sk-or-...',
  'openai-compatible': 'sk-... (optional)',
}

export function ProvidersTab({
  onNavigateToDefaults,
}: {
  onNavigateToDefaults: () => void
}) {
  const {
    data: loadedCredentials,
    loading,
    error,
    refresh,
  } = useAsyncResource(() => listCredentials(), [], {
    fallbackError: 'Failed to load credentials.',
  })
  const [createdCredential, setCreatedCredential] = useState<CredentialView | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [removeCandidate, setRemoveCandidate] = useState<CredentialView | null>(null)

  const loaded = loadedCredentials ?? []
  const credentials = createdCredential && !loaded.some((item) => item.id === createdCredential.id)
    ? [createdCredential, ...loaded]
    : loaded

  const effectiveSelection: Selection = selection
    ?? (credentials[0]
      ? { kind: 'credential', id: credentials[0].id }
      : { kind: 'provider', providerId: 'anthropic' })
  const selectedCredential = effectiveSelection.kind === 'credential'
    ? credentials.find((credential) => credential.id === effectiveSelection.id)
    : undefined

  async function handleTest(credential: CredentialView) {
    setBusyIds((previous) => new Set(previous).add(credential.id))
    try {
      const result = await testCredential(credential.id)
      setTestResults((previous) => ({ ...previous, [credential.id]: result }))
      if (!result.ok) {
        pushToast({
          kind: 'error',
          title: 'Connection test failed',
          body: result.error ?? 'The provider rejected the credential.',
        })
      }
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Connection test failed',
        body: getErrorMessage(err, 'Unknown provider connection error'),
      })
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous)
        next.delete(credential.id)
        return next
      })
    }
  }

  async function handleDelete(credential: CredentialView) {
    setBusyIds((previous) => new Set(previous).add(credential.id))
    try {
      await deleteCredential(credential.id)
      const nextCredential = credentials.find((item) => item.id !== credential.id)
      setSelection(nextCredential
        ? { kind: 'credential', id: nextCredential.id }
        : { kind: 'provider', providerId: credential.providerId })
      if (createdCredential?.id === credential.id) setCreatedCredential(null)
      setRemoveCandidate(null)
      refresh()
      pushToast({ kind: 'success', title: 'Credential removed' })
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Could not remove credential',
        body: getErrorMessage(err, 'Unknown credential removal error'),
      })
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous)
        next.delete(credential.id)
        return next
      })
    }
  }

  function handleCreated(credential: CredentialView) {
    setCreatedCredential(credential)
    setSelection({ kind: 'credential', id: credential.id })
    refresh()
  }

  return (
    <section className={styles.settingsWorkspace} aria-labelledby="providers-heading">
      <aside className={styles.settingsBrowser} aria-label="Provider browser">
        <div className={styles.settingsBrowserHeader}>
          <h2 id="providers-heading">Providers</h2>
        </div>

        {error && <p role="alert" className={styles.settingsBrowserError}>{error}</p>}

        <div className={styles.settingsBrowserSections}>
          {(loading || credentials.length > 0) && (
            <AiSettingsListSection label="Credentials">
              {loading && credentials.length === 0 ? (
                <p className={styles.settingsBrowserEmpty}>Loading credentials…</p>
              ) : (
                credentials.map((credential) => {
                  const provider = getProviderSpec(credential.providerId)
                  const testResult = testResults[credential.id]
                  const healthy = credential.keyFingerprintCurrent && testResult?.ok !== false
                  const active = effectiveSelection.kind === 'credential'
                    && effectiveSelection.id === credential.id
                  return (
                    <Button
                      key={credential.id}
                      type="button"
                      variant="ghost"
                      size="md"
                      fullWidth
                      active={active}
                      align="start"
                      className={styles.settingsListItem}
                      onClick={() => setSelection({ kind: 'credential', id: credential.id })}
                      aria-current={active ? 'true' : undefined}
                    >
                      <ProviderMark providerId={credential.providerId} size="sm" />
                      <span className={styles.settingsListIdentity}>
                        <span className={styles.settingsListLabel}>{credential.displayLabel}</span>
                        <span className={styles.settingsListMeta}>
                          <span className={healthy ? styles.healthDot : styles.warningDot} />
                          {healthy ? provider.label : 'Needs attention'}
                        </span>
                      </span>
                      {!active && <ArrowRightIcon size={13} aria-hidden="true" />}
                    </Button>
                  )
                })
              )}
            </AiSettingsListSection>
          )}

          <AiSettingsListSection label="Add provider">
            {PROVIDER_SPECS.map((provider) => {
              const active = effectiveSelection.kind === 'provider'
                && effectiveSelection.providerId === provider.id
              return (
                <Button
                  key={provider.id}
                  type="button"
                  variant="ghost"
                  size="md"
                  fullWidth
                  active={active}
                  align="start"
                  className={styles.settingsListItem}
                  onClick={() => setSelection({ kind: 'provider', providerId: provider.id })}
                  aria-current={active ? 'true' : undefined}
                >
                  <ProviderMark providerId={provider.id} size="sm" />
                  <span className={styles.settingsListIdentity}>
                    <span className={styles.settingsListLabel}>{provider.label}</span>
                    <span className={styles.settingsListMeta}>{provider.shortLabel}</span>
                  </span>
                  {!active && <ArrowRightIcon size={13} aria-hidden="true" />}
                </Button>
              )
            })}
          </AiSettingsListSection>
        </div>
      </aside>

      <div className={styles.settingsDetailCanvas}>
        {selectedCredential ? (
          <CredentialDetail
            key={selectedCredential.id}
            credential={selectedCredential}
            busy={busyIds.has(selectedCredential.id)}
            testResult={testResults[selectedCredential.id]}
            onTest={() => handleTest(selectedCredential)}
            onRemove={() => setRemoveCandidate(selectedCredential)}
            onNavigateToDefaults={onNavigateToDefaults}
          />
        ) : effectiveSelection.kind === 'provider' ? (
          <ProviderSetupPanel
            key={effectiveSelection.providerId}
            provider={getProviderSpec(effectiveSelection.providerId)}
            onCreated={handleCreated}
          />
        ) : null}
      </div>

      {removeCandidate && (
        <Dialog
          open
          onClose={() => setRemoveCandidate(null)}
          title="Remove credential?"
          size="sm"
          footer={(
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRemoveCandidate(null)}
                disabled={busyIds.has(removeCandidate.id)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void handleDelete(removeCandidate)}
                disabled={busyIds.has(removeCandidate.id)}
              >
                <TrashSolidIcon size={13} aria-hidden="true" />
                <span>Remove credential</span>
              </Button>
            </>
          )}
        >
          <p className={styles.removeDialogCopy}>
            This permanently removes <strong>{removeCandidate.displayLabel}</strong> and clears
            access for any AI surface that depends on it.
          </p>
        </Dialog>
      )}
    </section>
  )
}

function CredentialDetail({
  credential,
  busy,
  testResult,
  onTest,
  onRemove,
  onNavigateToDefaults,
}: {
  credential: CredentialView
  busy: boolean
  testResult: TestResult | undefined
  onTest: () => Promise<void>
  onRemove: () => void
  onNavigateToDefaults: () => void
}) {
  const provider = getProviderSpec(credential.providerId)
  const {
    data: models,
    loading: modelsLoading,
    error: modelsError,
  } = useAsyncResource(
    () => listModels(credential.providerId, credential.id),
    [credential.id, credential.providerId],
    { fallbackError: 'Could not load this provider model catalogue.' },
  )
  const status = !credential.keyFingerprintCurrent
    ? 'Re-enter key'
    : testResult?.ok === true
      ? 'Connected'
      : 'Configured'

  return (
    <article className={styles.credentialDetail} aria-labelledby="credential-detail-title">
      <header className={styles.credentialDetailHeader}>
        <div className={styles.credentialDetailIdentity}>
          <ProviderMark providerId={credential.providerId} size="lg" />
          <div>
            <div className={styles.credentialTitleRow}>
              <h2 id="credential-detail-title">{credential.displayLabel}</h2>
              <span
                className={credential.keyFingerprintCurrent
                  ? styles.connectionStatus
                  : styles.connectionStatusWarning}
              >
                <span className={credential.keyFingerprintCurrent ? styles.healthDot : styles.warningDot} />
                {status}
              </span>
            </div>
            <p>{provider.label}</p>
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="md"
          onClick={() => void onTest()}
          disabled={busy}
        >
          <CheckIcon size={14} aria-hidden="true" />
          <span>Test connection</span>
        </Button>
      </header>

      {testResult && (
        <p
          role="status"
          className={testResult.ok ? styles.connectionResultSuccess : styles.connectionResultError}
        >
          {testResult.ok
            ? `Connection is healthy. ${testResult.modelCount ?? 0} models available.`
            : testResult.error ?? 'Connection test failed.'}
        </p>
      )}

      <DetailSection title="Connection">
        <dl className={styles.connectionDetails}>
          <DetailRow label="Authentication" value={credential.authMode === 'apiKey' ? 'API key' : 'Endpoint URL'} />
          <DetailRow label="Credential" value="Encrypted credential" />
          <DetailRow label="Endpoint" value={credential.baseUrl ?? provider.endpointLabel} code={Boolean(credential.baseUrl)} />
          <DetailRow
            label="Last used"
            value={credential.lastUsedAt ? new Date(credential.lastUsedAt).toLocaleString() : 'Not used yet'}
          />
        </dl>
      </DetailSection>

      <DetailSection
        title="Available models"
        description="Models returned by this provider for the current credential."
        action={(
          <Button type="button" variant="ghost" size="sm" onClick={onNavigateToDefaults}>
            <span>Set defaults</span>
            <ArrowRightIcon size={12} aria-hidden="true" />
          </Button>
        )}
      >
        <ModelsTable models={models ?? []} loading={modelsLoading} error={modelsError} />
      </DetailSection>

      <div className={styles.credentialDangerZone}>
        <Button type="button" variant="ghost" tone="danger" size="sm" onClick={onRemove}>
          <TrashSolidIcon size={14} aria-hidden="true" />
          <span>Remove credential</span>
        </Button>
        <p>This permanently deletes the credential and removes access for all scopes.</p>
      </div>
    </article>
  )
}

function DetailSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className={styles.detailSection}>
      <div className={styles.detailSectionHeader}>
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function DetailRow({
  label,
  value,
  code = false,
}: {
  label: string
  value: string
  code?: boolean
}) {
  return (
    <div className={styles.connectionDetailRow}>
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  )
}

function ModelsTable({
  models,
  loading,
  error,
}: {
  models: AiModel[]
  loading: boolean
  error: string | null
}) {
  if (loading) return <p className={styles.detailEmpty}>Loading model catalogue…</p>
  if (error) return <p role="alert" className={styles.detailInlineError}>{error}</p>
  if (models.length === 0) return <p className={styles.detailEmpty}>No models reported by this provider.</p>

  return (
    <div className={styles.modelsTable} role="table" aria-label="Available models">
      <div className={styles.modelsTableHeader} role="row">
        <span role="columnheader">Model</span>
        <span role="columnheader">Context window</span>
        <span role="columnheader">Status</span>
      </div>
      {models.slice(0, 8).map((model) => (
        <div key={model.id} className={styles.modelsTableRow} role="row">
          <span role="cell" className={styles.modelIdentity}>
            <strong>{model.label}</strong>
            <code>{model.id}</code>
          </span>
          <span role="cell">{formatContextWindow(model.contextWindow)}</span>
          <span role="cell" className={styles.modelAvailability}>
            <span className={styles.healthDot} />
            Available
          </span>
        </div>
      ))}
    </div>
  )
}

function formatContextWindow(contextWindow: number | undefined): string {
  if (!contextWindow) return 'Not reported'
  if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(1).replace('.0', '')}M tokens`
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K tokens`
  return `${contextWindow} tokens`
}

function ProviderSetupPanel({
  provider,
  onCreated,
}: {
  provider: ProviderSpec
  onCreated: (credential: CredentialView) => void
}) {
  return (
    <article className={styles.providerSetup} aria-labelledby="provider-setup-title">
      <header className={styles.providerSetupHeader}>
        <ProviderMark providerId={provider.id} size="lg" />
        <div>
          <span className={styles.detailEyebrow}>Add provider</span>
          <h2 id="provider-setup-title">Connect {provider.label}</h2>
          <p>{provider.description}</p>
        </div>
      </header>

      <section className={styles.providerSetupFormSection}>
        <div className={styles.detailSectionHeader}>
          <div>
            <h3>Connection details</h3>
            <p>Instatic validates and encrypts the credential before storing it.</p>
          </div>
        </div>
        <AddCredentialForm provider={provider} onCreated={onCreated} />
      </section>

    </article>
  )
}

function AddCredentialForm({
  provider,
  onCreated,
}: {
  provider: ProviderSpec
  onCreated: (credential: CredentialView) => void
}) {
  const formId = useId()
  const labelInputId = useId()
  const apiKeyInputId = useId()
  const baseUrlInputId = useId()
  const [displayLabel, setDisplayLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const baseUrlPlaceholder = provider.id === 'ollama'
    ? 'http://localhost:11434'
    : 'https://api.example.com/v1'

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const body: CreateCredentialBody = provider.authMode === 'apiKey'
        ? {
            providerId: provider.id,
            authMode: 'apiKey',
            displayLabel,
            apiKey,
          }
        : {
            providerId: provider.id,
            authMode: 'baseUrl',
            displayLabel,
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
          }
      const credential = await createCredential(body)
      onCreated(credential)
      pushToast({ kind: 'success', title: `${provider.label} connected` })
    } catch (err) {
      pushToast({
        kind: 'error',
        title: `Could not connect ${provider.label}`,
        body: getErrorMessage(err, 'Unknown provider connection error'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form id={formId} className={styles.providerSetupForm} onSubmit={(event) => void handleSubmit(event)}>
      <div className={styles.providerSetupField}>
        <label htmlFor={labelInputId}>Display label</label>
        <div>
          <Input
            id={labelInputId}
            value={displayLabel}
            onChange={(event) => setDisplayLabel(event.currentTarget.value)}
            placeholder={`e.g. ${provider.label} production`}
            required
          />
          <p>Use a name teammates will recognize in model pickers.</p>
        </div>
      </div>

      {provider.authMode === 'baseUrl' && (
        <div className={styles.providerSetupField}>
          <label htmlFor={baseUrlInputId}>Base URL</label>
          <div>
            <Input
              id={baseUrlInputId}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
              placeholder={baseUrlPlaceholder}
              required
            />
            <p>The root URL of the compatible API.</p>
          </div>
        </div>
      )}

      <div className={styles.providerSetupField}>
        <label htmlFor={apiKeyInputId}>
          {provider.authMode === 'apiKey'
            ? 'API key'
            : provider.id === 'ollama' ? 'Bearer token' : 'API key'}
          {provider.authMode === 'baseUrl' && <span>Optional</span>}
        </label>
        <div>
          <Input
            id={apiKeyInputId}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder={API_KEY_PLACEHOLDER[provider.id] ?? 'Leave blank if no auth'}
            autoComplete="new-password"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            required={provider.authMode === 'apiKey'}
          />
          <p>{provider.authMode === 'apiKey' ? 'Stored encrypted and never displayed again.' : 'Leave blank when the endpoint does not require authentication.'}</p>
        </div>
      </div>

      <div className={styles.providerSetupActions}>
        <Button type="submit" variant="primary" size="md" disabled={busy}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>{busy ? 'Connecting…' : `Connect ${provider.label}`}</span>
        </Button>
      </div>
    </form>
  )
}
