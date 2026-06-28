/**
 * Providers tab — list, add, test, delete AI provider credentials.
 *
 * Every credential is per-user (handled server-side); the view shown here
 * is the wire-safe `CredentialView` (no plaintext, no ciphertext).
 */

import { useId, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import {
  type CredentialView,
  type CreateCredentialBody,
  type TestResult,
  createCredential,
  deleteCredential,
  listCredentials,
  testCredential,
} from '../../../ai/api'
import { ApiError } from '@core/http'
import styles from '../AiPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

type ProviderId = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'openai-compatible'
type AuthMode = 'apiKey' | 'baseUrl'

// Each provider has exactly one credential shape; the UI derives it instead
// of asking the user to choose an auth mode that cannot vary.
const PROVIDERS: Array<{ id: ProviderId; label: string; authMode: AuthMode }> = [
  { id: 'anthropic', label: 'Anthropic (Claude)', authMode: 'apiKey' },
  { id: 'openai', label: 'OpenAI', authMode: 'apiKey' },
  { id: 'openrouter', label: 'OpenRouter', authMode: 'apiKey' },
  { id: 'ollama', label: 'Ollama (local)', authMode: 'baseUrl' },
  { id: 'openai-compatible', label: 'Custom Provider', authMode: 'baseUrl' },
]

const AUTH_MODE_LABEL: Record<AuthMode, string> = {
  apiKey: 'API key',
  baseUrl: 'Endpoint URL',
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  'openai-compatible': 'Custom Provider',
}

// Hint text for the API-key field, per provider key prefix.
const API_KEY_PLACEHOLDER: Partial<Record<ProviderId, string>> = {
  anthropic: 'sk-ant-...',
  openrouter: 'sk-or-...',
  'openai-compatible': 'sk-... (optional)',
}

async function deleteCredentialAction(
  id: string,
  setBusyIds: (updater: (prev: Set<string>) => Set<string>) => void,
  setActionError: (error: string | null) => void,
  refresh: () => void,
): Promise<void> {
  setBusyIds((prev) => new Set(prev).add(id))
  try {
    await deleteCredential(id)
    setActionError(null)
    refresh()
  } catch (err) {
    setActionError(getErrorMessage(err, 'Failed to delete credential.'))
  } finally {
    setBusyIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }
}

async function testCredentialAction(
  id: string,
  setBusyIds: (updater: (prev: Set<string>) => Set<string>) => void,
  setTestResults: (updater: (prev: Record<string, TestResult & { ts: number }>) => Record<string, TestResult & { ts: number }>) => void,
): Promise<void> {
  setBusyIds((prev) => new Set(prev).add(id))
  try {
    const result = await testCredential(id)
    setTestResults((prev) => ({ ...prev, [id]: { ...result, ts: Date.now() } }))
  } catch (err) {
    const message = getErrorMessage(err, 'Test failed.')
    setTestResults((prev) => ({ ...prev, [id]: { ok: false, error: message, ts: Date.now() } }))
  } finally {
    setBusyIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }
}

export function ProvidersTab() {
  const {
    data: loadedCredentials,
    loading,
    error: loadError,
    refresh,
  } = useAsyncResource(() => listCredentials(), [], {
    fallbackError: 'Failed to load credentials.',
  })
  const credentials: CredentialView[] = loadedCredentials ?? []
  const [showDialog, setShowDialog] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, TestResult & { ts: number }>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  // Errors from mutations (delete/create) live alongside the load error from
  // the resource; the view shows whichever is present.
  const [actionError, setActionError] = useState<string | null>(null)
  const error = loadError ?? actionError

  async function handleDelete(id: string) {
    await deleteCredentialAction(id, setBusyIds, setActionError, refresh)
  }

  async function handleTest(id: string) {
    await testCredentialAction(id, setBusyIds, setTestResults)
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Credentials</h2>
          <p>Provider credentials for AI features. Secrets are encrypted at rest.</p>
        </div>
        <Button type="button" variant="primary" size="sm" onClick={() => setShowDialog(true)}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Add credential</span>
        </Button>
      </div>

      {error && <p role="alert" className={styles.errorAlert}>{error}</p>}

      {loading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : credentials.length === 0 ? (
        <div className={styles.emptyState}>
          No credentials yet. Add one to start using AI features.
        </div>
      ) : (
        <div className={styles.credentialGrid}>
          {credentials.map((cred) => {
            const isBusy = busyIds.has(cred.id)
            const result = testResults[cred.id]
            return (
              <div key={cred.id} className={styles.credentialCard}>
                <div className={styles.credentialIdentity}>
                  <div className={styles.credentialLabel}>{cred.displayLabel}</div>
                  <div className={styles.credentialMeta}>
                    <span>{PROVIDER_LABEL[cred.providerId]}</span>
                    <span>·</span>
                    <span>{AUTH_MODE_LABEL[cred.authMode]}</span>
                    {!cred.keyFingerprintCurrent && (
                      <span className={`${styles.statusBadge} ${styles.warning}`}>
                        Master key rotated — re-enter
                      </span>
                    )}
                    {cred.lastUsedAt && (
                      <>
                        <span>·</span>
                        <span>Last used {new Date(cred.lastUsedAt).toLocaleString()}</span>
                      </>
                    )}
                  </div>
                  {result && (
                    <p
                      role="status"
                      className={`${styles.testResult} ${result.ok ? styles.success : styles.danger}`}
                    >
                      {result.ok
                        ? `✓ Test ok (${result.modelCount ?? 0} models available)`
                        : `✗ ${result.error ?? 'Test failed.'}`}
                    </p>
                  )}
                </div>
                <div className={styles.credentialActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleTest(cred.id)}
                    disabled={isBusy}
                  >
                    <CheckIcon size={14} aria-hidden="true" />
                    <span>Test</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleDelete(cred.id)}
                    disabled={isBusy}
                  >
                    <TrashSolidIcon size={14} aria-hidden="true" />
                    <span>Delete</span>
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showDialog && (
        <AddCredentialDialog
          onClose={() => setShowDialog(false)}
          onCreated={() => {
            setShowDialog(false)
            setActionError(null)
            refresh()
          }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Add credential dialog
// ---------------------------------------------------------------------------

async function submitCredential(
  effectiveAuthMode: AuthMode,
  providerId: ProviderId,
  displayLabel: string,
  apiKey: string,
  baseUrl: string,
  onCreated: () => void,
  setError: (error: string | null) => void,
  setBusy: (busy: boolean) => void,
): Promise<void> {
  setError(null)
  setBusy(true)
  try {
    const body: CreateCredentialBody =
      effectiveAuthMode === 'apiKey' ? {
        providerId, authMode: 'apiKey', displayLabel, apiKey,
      } : {
        providerId, authMode: 'baseUrl', displayLabel, baseUrl,
        ...(apiKey ? { apiKey } : {}),
      }
    await createCredential(body)
    onCreated()
  } catch (err) {
    if (err instanceof ApiError) {
      setError(err.message)
    } else {
      setError(getErrorMessage(err, 'Failed to create credential.'))
    }
  } finally {
    setBusy(false)
  }
}

function AddCredentialDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const providerInputId = useId()
  const labelInputId = useId()
  const apiKeyInputId = useId()
  const baseUrlInputId = useId()
  const formId = useId()

  const [providerId, setProviderId] = useState<ProviderId>('anthropic')
  const [displayLabel, setDisplayLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerSpec = PROVIDERS.find((p) => p.id === providerId)!
  const effectiveAuthMode = providerSpec.authMode
  const baseUrlPlaceholder =
    providerId === 'ollama' ? 'http://localhost:11434' : 'https://api.groq.com/openai/v1'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await submitCredential(effectiveAuthMode, providerId, displayLabel, apiKey, baseUrl, onCreated, setError, setBusy)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add AI credential"
      size="md"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>Cancel</span>
          </Button>
          <Button type="submit" form={formId} variant="primary" size="sm" disabled={busy}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Add credential</span>
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.dialogForm} onSubmit={(e) => void handleSubmit(e)}>
        <div className={styles.dialogField}>
          <label htmlFor={providerInputId} className={styles.dialogFieldLabel}>Provider</label>
          <Select
            id={providerInputId}
            value={providerId}
            onChange={(e) => setProviderId(e.currentTarget.value as ProviderId)}
            options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
          />
        </div>

        <div className={styles.dialogField}>
          <label htmlFor={labelInputId} className={styles.dialogFieldLabel}>Display label</label>
          <Input
            id={labelInputId}
            value={displayLabel}
            onChange={(e) => setDisplayLabel(e.currentTarget.value)}
            placeholder="e.g. Production"
            required
          />
        </div>

        {effectiveAuthMode === 'apiKey' && (
          <div className={styles.dialogField}>
            <label htmlFor={apiKeyInputId} className={styles.dialogFieldLabel}>API key</label>
            <Input
              id={apiKeyInputId}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value)}
              placeholder={API_KEY_PLACEHOLDER[providerId] ?? 'sk-...'}
              // Browsers ignore autoComplete="off" on password fields and
              // inject the saved admin login. "new-password" suppresses that;
              // the data-* attributes opt out of password-manager overlays.
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              required
            />
          </div>
        )}

        {effectiveAuthMode === 'baseUrl' && (
          <>
            <div className={styles.dialogField}>
              <label htmlFor={baseUrlInputId} className={styles.dialogFieldLabel}>Base URL</label>
              <Input
                id={baseUrlInputId}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.currentTarget.value)}
                placeholder={baseUrlPlaceholder}
                required
              />
            </div>
            <div className={styles.dialogField}>
              <label htmlFor={apiKeyInputId} className={styles.dialogFieldLabel}>
                {providerId === 'ollama' ? 'Bearer token (optional)' : 'API key (optional)'}
              </label>
              <Input
                id={apiKeyInputId}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.currentTarget.value)}
                placeholder="Leave blank if no auth"
                // See the API key field above: "new-password" + data-* opt-outs
                // stop the browser/password manager autofilling the admin login.
                autoComplete="new-password"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
              />
            </div>
          </>
        )}

        {error && <p role="alert" className={styles.dialogError}>{error}</p>}
      </form>
    </Dialog>
  )
}
