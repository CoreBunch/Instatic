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
import { isMemberAppScope, pluginAppScopeText, type MemberApp, type MemberAppScopeOption } from '@core/members'
import { createCmsMemberApp, deleteCmsMemberApp, listCmsMemberApps } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { Input, Textarea } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { PlugSolidIcon } from 'pixel-art-icons/icons/plug-solid'
import styles from './Members.module.css'

const FORM_ID = 'member-app-form'
const MAX_REDIRECTS = 10

/** A scope in words. One no longer on offer (its plugin is gone) is shown by name. */
function scopeText(scope: string, options: readonly MemberAppScopeOption[]): string {
  const option = options.find((each) => each.scope === scope)
  if (!option) return `${scope} (no longer offered)`
  return option.plugin ? pluginAppScopeText(option.plugin, option.text) : option.text
}

/** A new app starts with the built-in access; a plugin's is the owner's to add. */
function defaultScopes(options: readonly MemberAppScopeOption[]): string[] {
  return options.filter((option) => isMemberAppScope(option.scope)).map((option) => option.scope)
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
function formBlocker(name: string, redirects: string[], scopes: readonly string[]): string | null {
  if (!name.trim()) return 'Give the app a name.'
  if (redirects.length === 0) return 'Enter at least one redirect address.'
  if (redirects.length > MAX_REDIRECTS) return `An app can have at most ${MAX_REDIRECTS} redirect addresses.`
  if (!redirects.every(redirectAllowed)) return 'Redirect addresses must use https, or http on this machine (127.0.0.1).'
  if (scopes.length === 0) return 'Choose at least one thing the app may ask for.'
  return null
}

function AppRow({
  app,
  scopeOptions,
  canManage,
  busy,
  onRemove,
}: {
  app: MemberApp
  scopeOptions: readonly MemberAppScopeOption[]
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
        <dd>{app.scopes.map((scope) => scopeText(scope, scopeOptions)).join('; ')}</dd>
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

export function MemberAppsDialog({
  canManage,
  approvalPageLive,
  onClose,
}: {
  canManage: boolean
  /** Whether Member settings names a published "Approve an app" page. */
  approvalPageLive: boolean
  onClose: () => void
}) {
  const { runStepUp } = useStepUp()
  const registry = useAsyncResource((signal) => listCmsMemberApps(signal), [], { fallbackError: 'Could not load the apps.' })
  const apps = registry.data?.apps
  const scopeOptions = registry.data?.availableScopes ?? []
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [redirectText, setRedirectText] = useState('')
  // Null until the owner touches a box: the built-in access is ticked to start with.
  const [chosenScopes, setChosenScopes] = useState<readonly string[] | null>(null)
  const scopes = chosenScopes ?? defaultScopes(scopeOptions)
  const idPrefix = useId()

  const redirects = [...new Set(redirectText.split('\n').map((line) => line.trim()).filter(Boolean))]
  const blocker = formBlocker(name, redirects, scopes)

  /** Run one change behind the password prompt, report a failure, and reload the list. */
  async function change(action: () => Promise<unknown>, failure: string, done: string): Promise<boolean> {
    setBusy(true)
    try {
      await runStepUp(action)
      registry.refresh()
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
    setChosenScopes(null)
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
        {registry.loading && !apps && <p className={dialogStyles.hint}>Loading apps…</p>}
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
                scopeOptions={scopeOptions}
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
                {scopeOptions.map((option) => (
                  <label key={option.scope} className={dialogStyles.checkboxRow}>
                    <Checkbox
                      checked={scopes.includes(option.scope)}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        setChosenScopes(
                          scopeOptions
                            .map((each) => each.scope)
                            .filter((each) => (each === option.scope ? checked : scopes.includes(each))),
                        )
                      }
                    />
                    <span>{scopeText(option.scope, scopeOptions)}</span>
                  </label>
                ))}
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
      </div>
    </Dialog>
  )
}
