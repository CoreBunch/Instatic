/**
 * Site members: the people with an account on the published site. They are
 * not admin users (the tab next door): they sign in on the site itself, and
 * what they may open there is decided by their tags.
 *
 * The list is on the left with search and filters above it; the selected
 * member's details and actions are on the right.
 */
import { useEffect, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import ld from '@admin/shared/ListDetail/ListDetail.module.css'
import { useConfirmAction, useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { memberPageIsLive } from '@core/members'
import type {
  MemberAdminStatus,
  MemberDetail,
  MemberListItem,
  MemberSettings,
  MemberSignupMode,
  MemberTagGrant,
} from '@core/members'
import {
  deleteCmsMember,
  disconnectCmsMemberApp,
  getCmsMember,
  getCmsMemberSettings,
  grantCmsMemberTag,
  inviteCmsMember,
  listCmsMembers,
  revokeCmsMemberTag,
  saveCmsMemberSettings,
  signOutCmsMember,
  suspendCmsMember,
  unsuspendCmsMember,
  type CmsMemberListQuery,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { formatRelativeTimeAgo } from '@core/utils/relativeTime'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { RangeTabs } from '@ui/components/RangeTabs'
import { SearchBar } from '@ui/components/SearchBar'
import { Select } from '@ui/components/Select'
import { TagPill } from '@ui/components/TagPill'
import { pushToast } from '@ui/components/Toast'
import { PlugSolidIcon } from 'pixel-art-icons/icons/plug-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { forgetMemberProfileFields } from '@admin/shared/DataBindingPicker/cache'
import { InvitationLinkDialog } from '../members/InvitationLinkDialog'
import { InviteMemberDialog } from '../members/InviteMemberDialog'
import { MemberAppsDialog } from '../members/MemberAppsDialog'
import { MemberDetailPanel, type MemberActions } from '../members/MemberDetailPanel'
import { MemberSettingsDialog } from '../members/MemberSettingsDialog'
import { STATUS_LABEL, STATUS_TONE } from '../members/memberText'
import memberStyles from '../members/Members.module.css'
import styles from '../UsersPage.module.css'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'

type StatusFilter = 'all' | MemberAdminStatus

const ALL_TAGS = ''
const SEARCH_DELAY_MS = 250

const SIGNUP_SUMMARY: Record<MemberSignupMode, string> = {
  open: 'Sign-up is open: anyone can create an account on the site.',
  invite: 'Sign-up is by invitation: only people you invite can join.',
  closed: 'Sign-up is closed: nobody new can sign up. People you invite can still join.',
}

function isStepUpCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === StepUpCancelledMessage
}

export function MembersTab({
  canManage,
  onChanged,
}: {
  canManage: boolean
  /** Called after any change, so the Audit tab next door shows it. */
  onChanged: () => void
}) {
  const { runStepUp } = useStepUp()
  const confirmDelete = useConfirmDelete()
  const confirmAction = useConfirmAction()

  const [status, setStatus] = useState<StatusFilter>('all')
  const [tag, setTag] = useState(ALL_TAGS)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Pages read with "Show more", kept only while the filters they were read for still apply.
  const [more, setMore] = useState<{ key: string; members: MemberListItem[]; nextOffset: number | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<'invite' | 'settings' | 'apps' | null>(null)
  // A link the admin asked for, shown once so they can pass it on.
  const [invitationLink, setInvitationLink] = useState<{ email: string; link: string } | null>(null)
  // A change to the selected member answers with the member as it now stands.
  const [changed, setChanged] = useState<MemberDetail | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const query: CmsMemberListQuery = {
    search,
    status: status === 'all' ? null : status,
    tag: tag === ALL_TAGS ? null : tag,
  }
  const queryKey = JSON.stringify(query)
  const list = useAsyncResource((signal) => listCmsMembers(query, signal), [queryKey], {
    fallbackError: 'Could not load the members.',
  })
  const settings = useAsyncResource((signal) => getCmsMemberSettings(signal), [], {
    fallbackError: 'Could not load the member settings.',
  })

  const extra = more?.key === queryKey ? more : null
  const members = list.data ? [...list.data.members, ...(extra?.members ?? [])] : []
  const nextOffset = extra ? extra.nextOffset : (list.data?.nextOffset ?? null)
  const selected = members.find((member) => member.id === selectedId) ?? members[0] ?? null
  const filtered = status !== 'all' || tag !== ALL_TAGS || search.trim() !== ''

  const detailResource = useAsyncResource(
    (signal) => (selected ? getCmsMember(selected.id, signal) : Promise.resolve(null)),
    [selected?.id ?? ''],
    { fallbackError: 'Could not load the member.' },
  )
  const detail =
    changed && changed.member.id === selected?.id
      ? changed
      : detailResource.data?.member.id === selected?.id
        ? detailResource.data
        : null

  const mailAvailable = settings.data?.mailAvailable ?? false
  // Without outgoing email an invitation is still possible as a link to pass
  // on; only a site that does not know its own address cannot make one.
  const linkAvailable = settings.data?.linkAvailable ?? false
  const inviteBlocked = !canManage
    ? 'Your role cannot invite members'
    : !settings.data || !memberPageIsLive('invite', settings.data.settings.pages, settings.data.pageOptions)
      ? 'Invitations need a published page that accepts them. Choose "Accept an invitation" under Member settings.'
      : !linkAvailable
        ? 'The site does not know its public address yet, so it cannot make invitation links. Set PUBLIC_ORIGIN on the server.'
        : undefined

  function clearFilters() {
    setStatus('all')
    setTag(ALL_TAGS)
    setSearchInput('')
    setSearch('')
  }

  /** Run one change, report a failure, and refresh the list so counts and rows follow. */
  async function run(change: () => Promise<MemberDetail | void>, failure: string, done?: string): Promise<boolean> {
    setBusy(true)
    try {
      const result = await change()
      setChanged(result ?? null)
      setMore(null)
      list.refresh()
      onChanged()
      if (done) pushToast({ kind: 'success', title: done })
      return true
    } catch (err) {
      if (isStepUpCancelled(err)) return false
      console.error(`[MembersTab] ${failure}:`, err)
      pushToast({ kind: 'error', title: failure, body: getErrorMessage(err, 'Unknown member error') })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function showMore() {
    if (nextOffset === null) return
    setLoadingMore(true)
    try {
      const next = await listCmsMembers({ ...query, offset: nextOffset })
      setMore({ key: queryKey, members: [...(extra?.members ?? []), ...next.members], nextOffset: next.nextOffset })
    } catch (err) {
      console.error('[MembersTab] loading more members failed:', err)
      pushToast({ kind: 'error', title: 'Could not load more members', body: getErrorMessage(err, 'Unknown member error') })
    } finally {
      setLoadingMore(false)
    }
  }

  async function invite(email: string, tags: string[], delivery: 'email' | 'link') {
    let created: { email: string; link: string } | null = null
    const ok = await run(async () => {
      // Handing the link to the admin asks for the password again.
      const result = delivery === 'link'
        ? await runStepUp(() => inviteCmsMember(email, tags, delivery))
        : await inviteCmsMember(email, tags, delivery)
      setSelectedId(result.member.id)
      if (result.link) {
        created = { email: result.member.email, link: result.link }
        return
      }
      pushToast({
        kind: 'success',
        title: result.outcome === 'resent' ? 'Invitation sent again' : 'Invitation sent',
        body: `To ${result.member.email}.`,
      })
    }, delivery === 'link' ? 'The invitation link could not be created' : 'The invitation could not be sent')
    if (!ok) return
    setDialog(null)
    setInvitationLink(created)
  }

  async function saveSettings(next: MemberSettings) {
    const ok = await run(async () => {
      await runStepUp(() => saveCmsMemberSettings(next))
      forgetMemberProfileFields()
      settings.refresh()
    }, 'The member settings could not be saved', 'Member settings saved')
    if (ok) setDialog(null)
  }

  function actionsFor(member: MemberListItem): MemberActions {
    const who = member.name || member.email
    return {
      suspend: () =>
        confirmAction({
          title: `Suspend ${who}?`,
          description: 'They are signed out everywhere and cannot sign in. You can restore access later; they will have to sign in again.',
          confirmLabel: 'Suspend',
          commit: () => void run(() => suspendCmsMember(member.id), 'The member could not be suspended', `${who} is suspended`),
        }),
      restore: () => void run(() => unsuspendCmsMember(member.id), 'The member could not be restored', `${who} can sign in again`),
      signOut: () => void run(() => signOutCmsMember(member.id), 'The member could not be signed out', `${who} is signed out everywhere`),
      remove: () =>
        confirmDelete({
          title: `Delete ${who}?`,
          description: 'Their account, profile, tags and sessions are removed for good. The address can be used to sign up again.',
          confirmLabel: 'Delete member',
          alwaysConfirm: true,
          commit: () =>
            void run(async () => {
              await runStepUp(() => deleteCmsMember(member.id))
              setSelectedId(null)
            }, 'The member could not be deleted', `${who} is deleted`),
        }),
      resendInvitation: () => void invite(member.email, [], mailAvailable ? 'email' : 'link'),
      grantTag: (name, expiresAt) => void run(() => grantCmsMemberTag(member.id, name, expiresAt), 'The tag could not be added'),
      revokeTag: (grant: MemberTagGrant) =>
        void run(() => revokeCmsMemberTag(member.id, grant.tag, grant.source), 'The tag could not be removed'),
      disconnectApp: (app) =>
        void run(() => disconnectCmsMemberApp(member.id, app.id), 'The app could not be disconnected', `${who} is signed out of ${app.name}`),
    }
  }

  const counts = list.data?.counts

  return (
    <section className={styles.section} aria-labelledby="members-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="members-title">Site members</h2>
          <p>People with an account on your published site. Tags decide which protected pages they can open.</p>
        </div>
        <div className={memberStyles.headerActions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setDialog('settings')}
            disabled={!settings.data}
          >
            <Settings2SolidIcon size={12} aria-hidden="true" />
            Member settings
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setDialog('apps')}
            disabled={!settings.data}
          >
            <PlugSolidIcon size={12} aria-hidden="true" />
            Apps
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => setDialog('invite')}
            disabled={inviteBlocked !== undefined}
            tooltip={inviteBlocked}
          >
            <PlusIcon size={12} aria-hidden="true" />
            Invite member
          </Button>
        </div>
      </div>

      {(list.error || settings.error) && <p className={styles.error} role="alert">{list.error ?? settings.error}</p>}

      {settings.data && (
        <p className={memberStyles.signupNotice}>
          {settings.data.settings.signupMode === 'open' && !memberPageIsLive('verify', settings.data.settings.pages, settings.data.pageOptions)
            ? 'Sign-up is set to open, but no published "Confirm email" page is chosen, so nobody can sign up yet.'
            : SIGNUP_SUMMARY[settings.data.settings.signupMode]}
          <Button type="button" variant="ghost" size="xs" onClick={() => setDialog('settings')}>
            {canManage ? 'Change' : 'View settings'}
          </Button>
        </p>
      )}

      {list.loading && !list.data && <p className={styles.emptyState}>Loading members…</p>}

      {list.data && counts && (
        <>
          <div className={memberStyles.filters}>
            <SearchBar
              className={memberStyles.search}
              value={searchInput}
              onValueChange={setSearchInput}
              onClear={() => setSearchInput('')}
              placeholder="Search name or email"
              aria-label="Search name or email"
            />
            <RangeTabs<StatusFilter>
              value={status}
              options={[
                { value: 'all', label: `All ${counts.all.toLocaleString()}` },
                { value: 'active', label: `Active ${counts.active.toLocaleString()}` },
                { value: 'pending', label: `Pending ${counts.pending.toLocaleString()}` },
                { value: 'suspended', label: `Suspended ${counts.suspended.toLocaleString()}` },
              ]}
              onChange={setStatus}
              ariaLabel="Filter by status"
            />
            {list.data.tags.length > 0 && (
              <div className={memberStyles.filterSelect}>
                <Select
                  aria-label="Filter by tag"
                  fieldSize="sm"
                  value={tag}
                  options={[
                    { value: ALL_TAGS, label: 'All tags' },
                    ...list.data.tags.map((entry) => ({
                      value: entry.tag,
                      label: `${entry.tag} (${entry.count})`,
                      textValue: entry.tag,
                    })),
                  ]}
                  onChange={(event) => setTag(event.currentTarget.value)}
                />
              </div>
            )}
          </div>

          {members.length === 0 ? (
            <EmptyState
              variant="centered"
              icon={<UsersSolidIcon size={28} />}
              title={filtered ? 'No member matches these filters' : 'No members yet'}
              description={
                filtered
                  ? 'Try another search, or clear the filters to see everyone.'
                  : 'Members appear here when someone signs up on the site or accepts an invitation.'
              }
              action={
                filtered ? (
                  <Button type="button" variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>
                ) : undefined
              }
            />
          ) : (
            <div className={ld.split}>
              <div className={ld.list}>
                <div className={ld.listHeader}>
                  <span>
                    {list.data.matching.toLocaleString()} {list.data.matching === 1 ? 'member' : 'members'}
                    {filtered ? ' match' : ''}
                  </span>
                  {filtered && <Button type="button" variant="ghost" size="xs" onClick={clearFilters}>Clear filters</Button>}
                </div>
                <ul className={ld.rows} aria-label="Site members">
                  {members.map((member) => {
                    const active = selected?.id === member.id
                    return (
                      <li key={member.id}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="md"
                          fullWidth
                          align="start"
                          active={active}
                          aria-current={active ? 'true' : undefined}
                          className={ld.row}
                          onClick={() => {
                            setSelectedId(member.id)
                            setChanged(null)
                          }}
                        >
                          <span className={ld.dot} data-tone={STATUS_TONE[member.status]} aria-hidden="true" />
                          <span className={ld.rowMain}>
                            <span className={ld.rowSubject}>{member.name || member.email}</span>
                            <span className={ld.rowMeta}>
                              {member.name ? `${member.email} · ` : ''}
                              {STATUS_LABEL[member.status]}
                              {member.lastLoginAt
                                ? ` · signed in ${formatRelativeTimeAgo(Date.parse(member.lastLoginAt))}`
                                : ''}
                            </span>
                          </span>
                          <span className={memberStyles.rowTags}>
                            {member.tags.slice(0, 3).map((name) => (
                              <TagPill key={name} label={name} size="xs" monospace muted />
                            ))}
                            {member.tags.length > 3 && <TagPill label={`+${member.tags.length - 3}`} size="xs" muted />}
                          </span>
                        </Button>
                      </li>
                    )
                  })}
                </ul>
                <div className={ld.listFooter}>
                  {nextOffset !== null ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => void showMore()} busy={loadingMore}>
                      Show more
                    </Button>
                  ) : (
                    <span>End of the list.</span>
                  )}
                </div>
              </div>

              {selected && detail ? (
                <MemberDetailPanel
                  detail={detail}
                  canManage={canManage}
                  mailAvailable={mailAvailable}
                  inviteBlocked={inviteBlocked}
                  busy={busy}
                  actions={actionsFor(selected)}
                />
              ) : (
                <div className={ld.detail}>
                  <p className={memberStyles.plain}>{detailResource.error ?? 'Loading…'}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {dialog === 'invite' && (
        <InviteMemberDialog
          busy={busy}
          mailAvailable={mailAvailable}
          onClose={() => setDialog(null)}
          onInvite={(email, tags, delivery) => void invite(email, tags, delivery)}
        />
      )}
      {invitationLink && (
        <InvitationLinkDialog email={invitationLink.email} link={invitationLink.link} onClose={() => setInvitationLink(null)} />
      )}
      {dialog === 'settings' && settings.data && (
        <MemberSettingsDialog
          settings={settings.data.settings}
          pageOptions={settings.data.pageOptions}
          canEdit={canManage}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={(next) => void saveSettings(next)}
        />
      )}
      {dialog === 'apps' && settings.data && (
        <MemberAppsDialog
          canManage={canManage}
          approvalPageLive={memberPageIsLive('appSignIn', settings.data.settings.pages, settings.data.pageOptions)}
          onClose={() => setDialog(null)}
          onChanged={onChanged}
        />
      )}
    </section>
  )
}
