/**
 * One member: who they are, what they can open (tags), where they are signed
 * in, what they did, and what an administrator can do about it.
 */
import { Alert } from '@ui/components/Alert'
import { useId, useState, type ReactNode, type FormEvent } from 'react'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import directory from '@admin/shared/Directory/Directory.module.css'
import ld from '@admin/shared/ListDetail/ListDetail.module.css'
import { isGrantableMemberTag, type MemberConnectedApp, type MemberDetail, type MemberTagGrant } from '@core/members'
import { formatRelativeTimeAgo } from '@core/utils/relativeTime'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { eventLabel, formatDate, formatDateTime, tagSourceLabel } from './memberText'
import styles from './Members.module.css'

const NO_PERMISSION = 'Your role cannot change members'

export interface MemberActions {
  suspend: () => void
  restore: () => void
  signOut: () => void
  downloadData: () => void
  remove: () => void
  resendInvitation: () => void
  grantTag: (tag: string, expiresAt: string | null) => void
  revokeTag: (grant: MemberTagGrant) => void
  disconnectApp: (app: MemberConnectedApp) => void
}

export function MemberDetailPanel({
  detail,
  canManage,
  mailAvailable,
  inviteBlocked,
  busy,
  actions,
}: {
  detail: MemberDetail
  canManage: boolean
  /** Whether the site can email a link right now; an invitation needs it. */
  mailAvailable: boolean
  /** Why an invitation cannot be made right now (no invitation page, no public address), if it cannot. */
  inviteBlocked: string | undefined
  busy: boolean
  actions: MemberActions
}) {
  const [addingTag, setAddingTag] = useState(false)
  const { member } = detail
  const blocked = canManage ? undefined : NO_PERMISSION
  const profileEntries = Object.entries(detail.profile).filter(([key, value]) => key !== 'name' && value !== '' && value !== false)

  return (
    <>
      {member.status === 'pending' && (
        <Alert tone="warning" role="status">
          Not finished yet: this person has not confirmed their address. They were invited, signed up, or were given an
          account by a plugin. A sign-in link, a password reset or an invitation confirms it.
        </Alert>
      )}
      {member.status === 'suspended' && (
        <Alert tone="danger" role="status">
          Suspended: this member cannot sign in, and anything they had open stopped working.
        </Alert>
      )}

      {member.status === 'pending' && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={actions.resendInvitation}
          disabled={busy || inviteBlocked !== undefined}
          tooltip={inviteBlocked
            ?? (mailAvailable ? undefined : 'Outgoing email is not set up, so you get the link to pass on yourself')}
        >
          {mailAvailable ? 'Send an invitation link' : 'Create an invitation link'}
        </Button>
      )}

      <section className={directory.section} aria-label="Tags">
        <div className={styles.sectionHeading}>
          <h4>Tags</h4>
          {canManage && <Button variant="secondary" size="xs" aria-expanded={addingTag} onClick={() => setAddingTag(!addingTag)}>
            {addingTag ? 'Cancel' : 'Add tag'}
          </Button>}
        </div>
        {detail.grants.length === 0 ? (
          <p className={styles.plain}>No access tags.</p>
        ) : (
          <ul className={styles.grants}>
            {detail.grants.map((grant) => (
              <li key={`${grant.tag}:${grant.source}`} className={styles.grant}>
                <span className={styles.grantMain}>
                  <code>{grant.tag}</code>
                  <span className={styles.grantMeta} data-expired={grant.expired}>
                    {tagSourceLabel(grant.source)}
                    {grant.expiresAt
                      ? grant.expired
                        ? `, ended ${formatDate(grant.expiresAt)}`
                        : `, until ${formatDate(grant.expiresAt)}`
                      : ''}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => actions.revokeTag(grant)}
                  disabled={busy || !canManage}
                  tooltip={blocked}
                  aria-label={`Remove tag ${grant.tag} (${tagSourceLabel(grant.source)})`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {canManage && addingTag && <AddTagForm busy={busy} onAdd={actions.grantTag} />}
      </section>

      <section className={directory.section} aria-label="Account">
        <h4>Account</h4>
        <dl className={directory.facts}>
          <div>
            <dt>Joined</dt>
            <dd>{formatDateTime(member.createdAt)}</dd>
          </div>
          <div>
            <dt>Last signed in</dt>
            <dd>{member.lastLoginAt ? formatDateTime(member.lastLoginAt) : 'Never'}</dd>
          </div>
          <div>
            <dt>Email address</dt>
            <dd>{detail.emailVerified ? 'Confirmed' : 'Not confirmed yet'}</dd>
          </div>
          {profileEntries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd className={ld.selectable}>{value === true ? 'Yes' : String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className={styles.disclosures}>
        <DetailSection title="Signed in on" count={detail.sessions.length}>
          {detail.sessions.length === 0 ? (
            <p className={styles.plain}>Not signed in anywhere.</p>
          ) : (
            <ul className={styles.timeline}>
              {detail.sessions.map((session, index) => (
                <li key={`${session.createdAt}-${index}`}>
                  <span>{deviceLabel(session.userAgent)}{session.ipAddress ? ` · ${session.ipAddress}` : ''}</span>
                  <time dateTime={session.lastSeenAt} title={formatDateTime(session.lastSeenAt)}>
                    active {formatRelativeTimeAgo(Date.parse(session.lastSeenAt))}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Connected apps" count={detail.connectedApps.length}>
          {detail.connectedApps.length === 0 ? (
            <p className={styles.plain}>No apps are signed in to this account.</p>
          ) : (
            <ul className={styles.grants}>
              {detail.connectedApps.map((app) => (
                <li key={app.id} className={styles.grant}>
                  <span className={styles.grantMain}>
                    <span className={styles.appName}>{app.name}</span>
                    <span className={styles.grantMeta}>
                      {app.device && `${app.device} · `}
                      Connected {formatDate(app.connectedAt)}
                      {' · '}
                      {app.lastUsedAt ? `Last used ${formatDate(app.lastUsedAt)}` : 'Not used yet'}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => actions.disconnectApp(app)}
                    disabled={busy || !canManage}
                    tooltip={blocked}
                    aria-label={`Disconnect ${app.name}`}
                  >
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Activity" count={detail.events.length}>
          {detail.events.length === 0 ? (
            <p className={styles.plain}>Nothing yet.</p>
          ) : (
            <ul className={styles.timeline}>
              {detail.events.map((event, index) => (
                <li key={`${event.createdAt}-${index}`}>
                  <span>{eventLabel(event.kind)}</span>
                  <time dateTime={event.createdAt} title={formatDateTime(event.createdAt)}>
                    {formatRelativeTimeAgo(Date.parse(event.createdAt))}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      </div>
      {canManage && (
        <div className={directory.actions} role="group" aria-label="Member actions">
          <Button variant="secondary" size="md" disabled={busy} onClick={actions.downloadData}>
            Download data
          </Button>
          <Button variant="secondary" size="md" disabled={busy || detail.sessions.length === 0}
            tooltip={detail.sessions.length === 0 ? 'Not signed in anywhere' : undefined} onClick={actions.signOut}>
            Sign out everywhere
          </Button>
          {member.status === 'suspended' ? (
            <Button variant="ghost" size="md" disabled={busy} onClick={actions.restore}>Restore access</Button>
          ) : (
            <Button variant="ghost" size="md" disabled={busy} onClick={actions.suspend}>Suspend</Button>
          )}
          <Button variant="ghost" size="md" tone="danger" disabled={busy} onClick={actions.remove}>
            <TrashSolidIcon size={14} aria-hidden="true" /> Delete member
          </Button>
        </div>
      )}
    </>
  )
}

function DetailSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <section className={directory.section} aria-label={title}>
      <Button variant="ghost" align="between" className={styles.disclosure} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {title}
        <span>{count}{open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}</span>
      </Button>
      <div id={id} hidden={!open}>{children}</div>
    </section>
  )
}

/** A short name for a browser from its user agent; the raw string is rarely readable. */
function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'Browser'
  const system = /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Android/.test(userAgent) ? 'Android'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Windows/.test(userAgent) ? 'Windows'
    : /Linux/.test(userAgent) ? 'Linux'
    : ''
  return system ? `${browser} on ${system}` : browser
}

function AddTagForm({ busy, onAdd }: { busy: boolean; onAdd: (tag: string, expiresAt: string | null) => void }) {
  const [tag, setTag] = useState('')
  const [until, setUntil] = useState('')
  const tagId = useId()
  const untilId = useId()
  const normalized = tag.trim().toLowerCase().replace(/\s+/g, '-')
  const tagOk = isGrantableMemberTag(normalized)
  const today = new Date().toISOString().slice(0, 10)
  const untilOk = until === '' || until > today

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!tagOk || !untilOk || busy) return
    // A date means "through the end of that day", in the administrator's own time zone.
    onAdd(normalized, until === '' ? null : new Date(`${until}T23:59:59`).toISOString())
    setTag('')
    setUntil('')
  }

  return (
    <form className={styles.addTag} onSubmit={handleSubmit}>
      <label htmlFor={tagId}>
        Add a tag
        <Input
          id={tagId}
          fieldSize="sm"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="pro"
          invalid={tag !== '' && !tagOk}
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <label htmlFor={untilId}>
        Until (optional)
        <Input
          id={untilId}
          type="date"
          fieldSize="sm"
          value={until}
          min={today}
          invalid={!untilOk}
          onChange={(event) => setUntil(event.target.value)}
        />
      </label>
      <Button type="submit" variant="secondary" size="sm" disabled={!tagOk || !untilOk} busy={busy}>Add</Button>
    </form>
  )
}
