import { useState } from 'react'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useLocation, useNavigate } from '@admin/lib/routing'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { CapabilityGroups, CapabilitySelectionSummary } from '@admin/shared/CapabilityPicker'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { CoreCapability } from '@core/capabilities'
import {
  decideMcpOAuthAuthorization,
  getMcpOAuthAuthorization,
} from '../../ai/api'
import {
  availableMcpCapabilityGroups,
  defaultMcpReadCapabilities,
} from './tabs/mcpCapabilities'
import styles from './McpOAuthAuthorizePage.module.css'

export function McpOAuthAuthorizePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const currentUser = useAuthenticatedAdminUser()
  const { runStepUp } = useStepUp()
  const groups = availableMcpCapabilityGroups(currentUser)
  const [selected, setSelected] = useState<Set<CoreCapability>>(
    () => defaultMcpReadCapabilities(groups),
  )
  const [busy, setBusy] = useState(false)
  const { data, loading, error } = useAsyncResource(
    () => getMcpOAuthAuthorization(location.search),
    [location.search],
    { fallbackError: 'This OAuth authorization request is invalid or has expired.' },
  )

  async function decide(decision: 'approve' | 'deny') {
    if (!data) return
    setBusy(true)
    try {
      const body = {
        decision,
        request: data.request,
        ...(decision === 'approve' ? { capabilities: [...selected] } : {}),
      } as const
      const redirectUrl = decision === 'approve'
        ? await runStepUp(() => decideMcpOAuthAuthorization(body))
        : await decideMcpOAuthAuthorization(body)
      window.location.assign(redirectUrl)
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      pushToast({
        kind: 'error',
        title: decision === 'approve' ? 'Could not authorize connection' : 'Could not deny connection',
        body: getErrorMessage(err, 'Unknown OAuth authorization error'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdminPageLayout
      workspace="ai"
      mode="workspace"
      footer={data && (
        <footer className={styles.footer} aria-label="Connection authorization">
          <div className={styles.footerContent}>
            <CapabilitySelectionSummary groups={groups} selected={selected} onChange={setSelected} />
            <div className={styles.actions}>
              <Button type="button" variant="secondary" size="sm" onClick={() => void decide('deny')} disabled={busy}>
                <span>Deny</span>
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void decide('approve')}
                disabled={busy || selected.size === 0}
              >
                <span>{busy ? 'Authorizing…' : 'Authorize connection'}</span>
              </Button>
            </div>
          </div>
        </footer>
      )}
    >
      <div className={styles.pageBody}>
        <header className={styles.heading}>
          <h1>Authorize MCP connection</h1>
          <p>Review the client and choose what it can access.</p>
        </header>
        {loading && <div className={styles.stateCard}>Loading authorization request…</div>}
        {error && (
          <div className={styles.stateCard} role="alert">
            <h2>Connection request unavailable</h2>
            <p>{error}</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => navigate('/admin/ai')}>
              <span>Back to AI settings</span>
            </Button>
          </div>
        )}
        {data && (
          <>
            <section className={styles.clientCard} aria-labelledby="oauth-client-name">
              <div>
                <span className={styles.eyebrow}>Requesting client</span>
                <h2 id="oauth-client-name">{data.clientName}</h2>
                <p>
                  After approval, Instatic sends a one-time authorization code to this registered callback.
                </p>
              </div>
              <code>{data.callbackUrl}</code>
              <p className={styles.trustNote}>
                Client names are self-declared. Approve only if you started this connection and
                recognize the callback address above.
              </p>
              <p>
                The connection expires after {data.grantExpiresInDays} days and can be disconnected at any time.
              </p>
            </section>

            <section className={styles.permissions} aria-labelledby="oauth-permissions-title">
              <div>
                <h2 id="oauth-permissions-title">Permissions</h2>
                <p>
                  Read access is selected by default. Writes and publishing stay off until you explicitly enable them.
                </p>
              </div>
              <CapabilityGroups groups={groups} selected={selected} onChange={setSelected} />
            </section>
          </>
        )}
      </div>
    </AdminPageLayout>
  )
}
