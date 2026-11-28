import { useId, useState, type FormEvent } from 'react'
import { Link } from '@admin/lib/routing'
import { acceptCmsUserInvitation } from '@core/persistence/auth'
import { MIN_PASSWORD_LENGTH } from '@core/utils/passwordPolicy'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import panel from '../AdminEntry.module.css'
import styles from './AdminPreAuthForm.module.css'

export function AcceptUserInvitation() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('invite'))
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const passwordId = useId()
  async function accept(event: FormEvent) {
    event.preventDefault()
    if (!token || busy) return
    setBusy(true)
    try {
      const result = await acceptCmsUserInvitation(token, password)
      setEmail(result.email)
      setPassword('')
      window.history.replaceState(window.history.state, '', window.location.pathname)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not accept invitation'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className={panel.page}>
      <section className={panel.panel} aria-labelledby="invite-title">
        <h1 id="invite-title" className={panel.title}>{email ? 'Invitation accepted' : 'Accept admin invitation'}</h1>
        {email ? (
          <><p>Your account is ready. Sign in with {email}.</p><Link to="/admin/dashboard">Continue to admin</Link></>
        ) : !token ? (
          <p role="alert">This invitation is missing its link. Ask for a new invitation.</p>
        ) : (
          <form className={styles.form} onSubmit={accept}>
            <label className={styles.field} htmlFor={passwordId}>
              <span>Choose a password</span>
              <Input id={passwordId} type="password" autoComplete="new-password" required
                minLength={MIN_PASSWORD_LENGTH} maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            {error && <p className={panel.error} role="alert">{error}</p>}
            <Button variant="primary" type="submit" busy={busy} disabled={busy}>Accept invitation</Button>
          </form>
        )}
      </section>
    </main>
  )
}
