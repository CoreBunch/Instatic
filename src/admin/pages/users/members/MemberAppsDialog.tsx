/**
 * Sign-in for apps: the apps the site owner allows to sign a member in
 * (Instatic Desktop, for one). An app sends its client id and one of its
 * redirect addresses; the member approves on the "Approve an app" page
 * chosen in Member settings.
 */
import { useId, useState, type FormEvent } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import {
  MEMBER_APP_SCOPES,
  MEMBER_APP_SCOPE_TEXT,
  type MemberApp,
  type MemberAppScope,
  type MemberSigningKey,
} from '@core/members'
import {
  createCmsMemberApp,
  deleteCmsMemberApp,
  listCmsMemberApps,
  rotateCmsMemberSigningKey,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { Input, Textarea } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { PlugSolidIcon } from 'pixel-art-icons/icons/plug-solid'
import { formatDate } from './memberText'
import styles from './Members.module.css'

const FORM_ID = 'member-app-form'
const MAX_REDIRECTS = 10
/** A new app starts without `offline`: only an app that keeps a device key can use it. */
const DEFAULT_SCOPES: readonly MemberAppScope[] = MEMBER_APP_SCOPES.filter((scope) => scope !== 'offline')

function isScope(value: string): value is MemberAppScope {
  return (MEMBER_APP_SCOPES as readonly string[]).includes(value)
}

/** A scope in words; a name this build does not know is shown as it is. */
function scopeText(scope: string): string {
  return isScope(scope) ? MEMBER_APP_SCOPE_TEXT[scope] : scope
}

/** The server's rule, read early: https anywhere, http only on this machine. */
function redirectAllowed(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch (_err) {
    // Not an address at all.
    return false
  }
  if (url.username || url.password || url.hash) return false
  if (url.protocol === 'https:') return true
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return url.protocol === 'http:' && (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '::1')
}

/** Why the form cannot be sent yet, or null when it can. */
function formBlocker(name: string, redirects: string[], scopes: readonly MemberAppScope[]): string | null {
  if (!name.trim()) return 'Give the app a name.'
  if (redirects.length === 0) return 'Enter at least one redirect address.'
  if (redirects.length > MAX_REDIRECTS) return `An app can have at most ${MAX_REDIRECTS} redirect addresses.`
  if (!redirects.every(redirectAllowed)) return 'Redirect addresses must use https, or http on this machine (127.0.0.1).'
  if (scopes.length === 0) return 'Choose at least one thing the app may ask for.'
  return null
}

function AppRow({
  app,
  canManage,
  busy,
  onRemove,
}: {
  app: MemberApp
  canManage: boolean
  busy: boolean
  onRemove: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(app.id)
      setCopied(true)
    } catch (_err) {
      // Clipboard access can be blocked; the id is on screen to copy by hand.
      setCopied(false)
    }
  }

  return (
    <li className={styles.app}>
      <div className={styles.appHead}>
        <strong className={styles.appName}>{app.name}</strong>
        {canManage && !confirming && (
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )}
      </div>
      <dl className={styles.appFacts}>
        <dt>Client id</dt>
        <dd className={styles.appId}>
          <code>{app.id}</code>
          <Button type="button" variant="ghost" size="xs" aria-label={`Copy the client id of ${app.name}`} onClick={() => void copy()}>
            <CopySolidIcon size={12} aria-hidden="true" />
            <span role="status">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        </dd>
        <dt>Redirects to</dt>
        <dd>
          {app.redirectUris.map((uri) => (
            <code key={uri}>{uri}</code>
          ))}
        </dd>
        <dt>May ask for</dt>
        <dd>{app.scopes.map(scopeText).join('; ')}</dd>
      </dl>
      {confirming && (
        <div className={styles.appConfirm} role="group" aria-label={`Remove ${app.name}`}>
          <p>Remove {app.name}? It can no longer sign anyone in, and everyone signed in through it is signed out.</p>
          <Button type="button" variant="secondary" size="xs" disabled={busy} onClick={() => setConfirming(false)}>
            Keep
          </Button>
          <Button type="button" variant="destructive" size="xs" busy={busy} onClick={onRemove}>
            Remove app
          </Button>
        </div>
      )}
    </li>
  )
}

/** The key offline statements are signed with, and the way to replace it. */
function SigningKeySection({
  signingKey,
  canManage,
  busy,
  onRotate,
}: {
  signingKey: MemberSigningKey
  canManage: boolean
  busy: boolean
  /** Resolves to whether the key was rotated. */
  onRotate: () => Promise<boolean>
}) {
  const [confirming, setConfirming] = useState(false)

  async function rotate() {
    if (await onRotate()) setConfirming(false)
  }

  return (
    <fieldset className={dialogStyles.group}>
      <legend className={dialogStyles.groupTitle}>Offline signing key</legend>
      <p className={dialogStyles.hint}>
        Apps that work offline check a signed statement from this site against this key.
      </p>
      <dl className={styles.appFacts}>
        <dt>Key id</dt>
        <dd>
          <code>{signingKey.id}</code>
        </dd>
        <dt>Created</dt>
        <dd>
          <time dateTime={signingKey.createdAt}>{formatDate(signingKey.createdAt)}</time>
        </dd>
      </dl>
      {!signingKey.usable && (
        <p role="alert" className={dialogStyles.errorText}>
          This key can no longer be read, because the server&apos;s secret key changed. Apps cannot get a new
          statement until you rotate it.
        </p>
      )}
      {!confirming && (
        <div className={styles.appSubmit}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canManage || busy}
            onClick={() => setConfirming(true)}
          >
            Rotate key
          </Button>
          {!canManage && (
            <p className={dialogStyles.hint} role="status">Someone who manages members can rotate the key.</p>
          )}
        </div>
      )}
      {confirming && (
        <div className={styles.appConfirm} role="group" aria-label="Rotate the signing key">
          <p>
            Rotate the signing key? Apps keep working: the old key stays valid for 7 days, and each app picks up the
            new one the next time it is online.
          </p>
          <Button type="button" variant="secondary" size="xs" disabled={busy} onClick={() => setConfirming(false)}>
            Keep
          </Button>
          <Button type="button" variant="destructive" size="xs" busy={busy} onClick={() => void rotate()}>
            Rotate key
          </Button>
        </div>
      )}
    </fieldset>
  )
}

export function MemberAppsDialog({
  canManage,
  approvalPageLive,
  onClose,
  onChanged,
}: {
  canManage: boolean
  /** Whether Member settings names a published "Approve an app" page. */
  approvalPageLive: boolean
  onClose: () => void
  /** Called after an app is added or removed or the key is rotated, so the Audit tab shows it. */
  onChanged: () => void
}) {
  const { runStepUp } = useStepUp()
  const registry = useAsyncResource((signal) => listCmsMemberApps(signal), [], { fallbackError: 'Could not load the apps.' })
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [redirectText, setRedirectText] = useState('')
  const [scopes, setScopes] = useState<readonly MemberAppScope[]>(DEFAULT_SCOPES)
  const idPrefix = useId()
  const apps = registry.data?.apps

  const redirects = [...new Set(redirectText.split('\n').map((line) => line.trim()).filter(Boolean))]
  const blocker = formBlocker(name, redirects, scopes)

  /** Run one change behind the password prompt, report a failure, and reload the list. */
  async function change(action: () => Promise<unknown>, failure: string, done: string): Promise<boolean> {
    setBusy(true)
    try {
      await runStepUp(action)
      registry.refresh()
      onChanged()
      pushToast({ kind: 'success', title: done })
      return true
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return false
      console.error(`[MemberAppsDialog] ${failure}:`, err)
      pushToast({ kind: 'error', title: failure, body: getErrorMessage(err, 'Unknown app error') })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (blocker || busy) return
    const appName = name.trim()
    const added = await change(
      () => createCmsMemberApp({ name: appName, redirectUris: redirects, scopes: [...scopes] }),
      'The app could not be added',
      `${appName} can sign members in`,
    )
    if (!added) return
    setName('')
    setRedirectText('')
    setScopes(DEFAULT_SCOPES)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Apps"
      size="lg"
      footer={<Button variant="secondary" size="sm" type="button" onClick={onClose}>Close</Button>}
    >
      <div className={dialogStyles.form}>
        <p className={dialogStyles.hint}>
          Apps listed here can ask a member to sign in. The member approves on the &quot;Approve an app&quot; page
          chosen in Member settings.
        </p>
        {!approvalPageLive && (
          <p role="status" className={styles.pageProblem}>
            Apps cannot sign anyone in until a published page is chosen under Member settings → Approve an app.
          </p>
        )}

        {registry.error && <p role="alert" className={dialogStyles.errorText}>{registry.error}</p>}
        {registry.loading && !registry.data && <p className={dialogStyles.hint}>Loading apps…</p>}
        {apps && apps.length === 0 && (
          <EmptyState
            variant="centered"
            icon={<PlugSolidIcon size={28} />}
            title="No apps yet"
            description={
              canManage
                ? 'Add an app below to let it sign your members in.'
                : 'No app can sign members in. Someone who manages members can add one.'
            }
          />
        )}
        {apps && apps.length > 0 && (
          <ul className={styles.apps} aria-label="Apps that can sign members in">
            {apps.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                canManage={canManage}
                busy={busy}
                onRemove={() =>
                  void change(() => deleteCmsMemberApp(app.id), 'The app could not be removed', `${app.name} is removed`)
                }
              />
            ))}
          </ul>
        )}

        {canManage && (
          <form id={FORM_ID} onSubmit={(event) => void handleSubmit(event)}>
            <fieldset className={dialogStyles.group}>
              <legend className={dialogStyles.groupTitle}>Add an app</legend>
              <div className={dialogStyles.field}>
                <label htmlFor={`${idPrefix}-name`} className={dialogStyles.label}>Name</label>
                <Input
                  id={`${idPrefix}-name`}
                  fieldSize="sm"
                  value={name}
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Instatic Desktop"
                />
                <p className={dialogStyles.hint}>Members see this name when the app asks them to sign in.</p>
              </div>
              <div className={dialogStyles.field}>
                <label htmlFor={`${idPrefix}-redirects`} className={dialogStyles.label}>Redirect addresses</label>
                <Textarea
                  id={`${idPrefix}-redirects`}
                  fieldSize="sm"
                  monospace
                  rows={3}
                  value={redirectText}
                  disabled={busy}
                  onChange={(event) => setRedirectText(event.target.value)}
                  placeholder="http://127.0.0.1/callback"
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <p className={dialogStyles.hint}>
                  One per line. Where the app is sent back to after the member answers: https, or http on this
                  machine (127.0.0.1, any port).
                </p>
              </div>
              <div className={dialogStyles.field}>
                <span className={dialogStyles.label}>The app may ask for</span>
                {MEMBER_APP_SCOPES.map((scope) => (
                  <label key={scope} className={dialogStyles.checkboxRow}>
                    <Checkbox
                      checked={scopes.includes(scope)}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        setScopes(MEMBER_APP_SCOPES.filter((each) => (each === scope ? checked : scopes.includes(each))))
                      }
                    />
                    <span>{MEMBER_APP_SCOPE_TEXT[scope]}</span>
                  </label>
                ))}
                <p className={dialogStyles.hint}>Offline needs the app to keep a device key.</p>
              </div>
              <div className={styles.appSubmit}>
                <Button variant="primary" size="sm" type="submit" disabled={blocker !== null} busy={busy}>
                  Add app
                </Button>
                {blocker && <p className={dialogStyles.hint} role="status">{blocker}</p>}
              </div>
            </fieldset>
          </form>
        )}

        {registry.data && (
          <SigningKeySection
            signingKey={registry.data.signingKey}
            canManage={canManage}
            busy={busy}
            onRotate={() => change(rotateCmsMemberSigningKey, 'The signing key could not be rotated', 'Signing key rotated')}
          />
        )}
      </div>
    </Dialog>
  )
}
