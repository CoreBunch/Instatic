/**
 * What an administrator does with members: list and search them, look at
 * one, invite, tag, suspend, sign out, delete. Also the account a plugin
 * creates without an invitation (`ensureMember`).
 *
 * Like the rest of `server/members`, nothing here knows about admin users,
 * capabilities or HTTP: the cms handler (`server/handlers/cms/members.ts`)
 * decides who may call these, and audits the call.
 */
import { DIRECTORY_PAGE_SIZE, directoryPageOffset } from '@core/users/directoryPagination'
import { discardQueuedMailForMember } from '../mail/delivery'
import type { DbClient } from '../db/client'
import type {
  MemberAdminStatus,
  MemberDetail,
  MemberListItem,
  MemberListResponse,
  MemberTagGrant,
} from '@core/members'
import { listConnectedMemberApps } from '@core/loops'
import { isoDate, nowIso } from '@core/utils/isoDate'
import { memberLinkPage, memberTokenLink, queueMemberMail } from './mail'
import { getMemberPagePaths } from './pages'
import {
  anonymizeMember,
  createMember,
  findMemberByEmail,
  findMemberById,
  grantMemberTag,
  grantMemberTagIfAbsent,
  listMemberEvents,
  setMemberProfile,
  recordMemberEvent,
  type MemberRecord,
} from './repository'
import { revokeAllMemberAppGrants, revokeMemberAppGrant } from './apps/store'
import { listMemberSessions, revokeAllMemberSessions } from './sessions'
import { issueMemberToken, withdrawMemberTokens } from './tokens'

/** The source recorded on a tag an administrator grants by hand. */
export const ADMIN_TAG_SOURCE = 'admin'

const NO_REQUEST = { ipAddress: null, userAgent: null }

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * A member whose account is not usable yet: no password and an unconfirmed
 * address. That is someone invited who has not accepted, and equally someone
 * who signed up and has not opened the confirmation link (their password
 * waits in that link).
 */
function isPending(member: Pick<MemberRecord, 'passwordHash' | 'emailVerifiedAt'>): boolean {
  return member.passwordHash === null && member.emailVerifiedAt === null
}

function adminStatus(member: Pick<MemberRecord, 'status' | 'passwordHash' | 'emailVerifiedAt'>): MemberAdminStatus {
  if (member.status === 'suspended') return 'suspended'
  return isPending(member) ? 'pending' : 'active'
}

/** The SQL condition for each admin status, over the `members` table aliased `m`. */
const STATUS_SQL: Record<MemberAdminStatus, string> = {
  suspended: `m.status = 'suspended'`,
  pending: `m.status = 'active' and m.password_hash is null and m.email_verified_at is null`,
  active: `m.status = 'active' and not (m.password_hash is null and m.email_verified_at is null)`,
}

// ─── List ──────────────────────────────────────────────────────────────────

interface ListRow {
  id: string
  email: string
  status: string
  password_hash: string | null
  email_verified_at: Date | string | null
  profile_json: unknown
  last_login_at: Date | string | null
  created_at: Date | string
}

function profileName(profile: unknown): string {
  if (!profile || typeof profile !== 'object') return ''
  const name = (profile as Record<string, unknown>).name
  return typeof name === 'string' ? name : ''
}

function toListItem(row: ListRow, tags: string[]): MemberListItem {
  return {
    id: row.id,
    email: row.email,
    name: profileName(row.profile_json),
    status: adminStatus({
      status: row.status === 'suspended' ? 'suspended' : 'active',
      passwordHash: row.password_hash,
      emailVerifiedAt: row.email_verified_at === null ? null : isoDate(row.email_verified_at),
    }),
    tags,
    createdAt: isoDate(row.created_at),
    lastLoginAt: row.last_login_at === null ? null : isoDate(row.last_login_at),
  }
}

/** Numbered (`$1`) or positional (`?`) placeholders, collected with their values. */
function parameters(db: DbClient) {
  const values: unknown[] = []
  return {
    values,
    add(value: unknown): string {
      values.push(value)
      return db.dialect === 'postgres' ? `$${values.length}` : '?'
    },
  }
}

/** The tags each of these members holds right now, by member id. */
async function activeTagsFor(db: DbClient, memberIds: readonly string[]): Promise<Map<string, string[]>> {
  const byMember = new Map<string, string[]>()
  if (memberIds.length === 0) return byMember
  const params = parameters(db)
  const now = params.add(nowIso())
  const ids = memberIds.map((id) => params.add(id)).join(', ')
  const { rows } = await db.unsafe<{ member_id: string; tag: string }>(
    `select distinct member_id, tag from member_tags
      where (expires_at is null or expires_at > ${now}) and member_id in (${ids})
      order by tag`,
    params.values,
  )
  for (const row of rows) byMember.set(row.member_id, [...(byMember.get(row.member_id) ?? []), row.tag])
  return byMember
}

export interface MemberListFilter {
  /** Matches the email address or the name. */
  search?: string
  status?: MemberAdminStatus
  /** Only members holding this tag right now. */
  tag?: string
  offset?: number
}

/** `%`, `_` and the backslash mean something in LIKE; a search is plain text, so they are dropped. */
function likePattern(search: string): string {
  return `%${search.toLowerCase().replace(/[%_\\]/g, '')}%`
}

export async function listMembersForAdmin(db: DbClient, filter: MemberListFilter = {}): Promise<MemberListResponse> {
  const params = parameters(db)
  const where = ['m.deleted_at is null']
  const search = filter.search?.trim() ?? ''
  if (search !== '') {
    // One placeholder per use: SQLite's `?` is positional.
    const emailPattern = params.add(likePattern(search))
    const profilePattern = params.add(likePattern(search))
    // The profile is JSON text; matching it as text finds the name without a dialect-specific JSON operator.
    where.push(
      `(m.email_normalized like ${emailPattern} or lower(cast(m.profile_json as text)) like ${profilePattern})`,
    )
  }
  if (filter.status) where.push(STATUS_SQL[filter.status])
  if (filter.tag) {
    const tag = params.add(filter.tag)
    const now = params.add(nowIso())
    where.push(
      `exists (select 1 from member_tags t where t.member_id = m.id and t.tag = ${tag}
                 and (t.expires_at is null or t.expires_at > ${now}))`,
    )
  }
  const condition = where.join(' and ')
  const filterValues = [...params.values]

  const { rows: matchingRows } = await db.unsafe<{ total: number }>(
    `select count(*) as total from members m where ${condition}`,
    filterValues,
  )
  const matching = Number(matchingRows[0]?.total ?? 0)
  const offset = directoryPageOffset(filter.offset ?? 0, matching)
  const limit = params.add(DIRECTORY_PAGE_SIZE)
  const skip = params.add(offset)
  const { rows } = await db.unsafe<ListRow>(
    `select m.id, m.email, m.status, m.password_hash, m.email_verified_at, m.profile_json,
            m.last_login_at, m.created_at
       from members m
      where ${condition}
      order by m.created_at desc, m.id desc
      limit ${limit} offset ${skip}`,
    params.values,
  )

  const count = async (status?: MemberAdminStatus): Promise<number> => {
    const { rows: counted } = await db.unsafe<{ total: number }>(
      `select count(*) as total from members m where m.deleted_at is null${status ? ` and ${STATUS_SQL[status]}` : ''}`,
      [],
    )
    return Number(counted[0]?.total ?? 0)
  }
  const { rows: tagRows } = await db<{ tag: string; total: number }>`
    select t.tag as tag, count(distinct t.member_id) as total
      from member_tags t
     where t.expires_at is null or t.expires_at > ${nowIso()}
     group by t.tag
     order by total desc, t.tag
  `

  const tags = await activeTagsFor(db, rows.map((row) => row.id))
  return {
    members: rows.map((row) => toListItem(row, tags.get(row.id) ?? [])),
    matching,
    offset,
    counts: {
      all: await count(),
      active: await count('active'),
      pending: await count('pending'),
      suspended: await count('suspended'),
    },
    tags: tagRows.map((row) => ({ tag: row.tag, count: Number(row.total) })),
  }
}

// ─── Detail ────────────────────────────────────────────────────────────────

async function listItemFor(db: DbClient, member: MemberRecord): Promise<MemberListItem> {
  const tags = await activeTagsFor(db, [member.id])
  return {
    id: member.id,
    email: member.email,
    name: profileName(member.profile),
    status: adminStatus(member),
    tags: tags.get(member.id) ?? [],
    createdAt: member.createdAt,
    lastLoginAt: member.lastLoginAt,
  }
}

async function listTagGrants(db: DbClient, memberId: string): Promise<MemberTagGrant[]> {
  const { rows } = await db<{ tag: string; source: string; expires_at: Date | string | null; created_at: Date | string }>`
    select tag, source, expires_at, created_at from member_tags
     where member_id = ${memberId}
     order by tag, source
  `
  const now = Date.now()
  return rows.map((row) => {
    const expiresAt = row.expires_at === null ? null : isoDate(row.expires_at)
    return {
      tag: row.tag,
      source: row.source,
      expiresAt,
      expired: expiresAt !== null && Date.parse(expiresAt) <= now,
      createdAt: isoDate(row.created_at),
    }
  })
}

export async function getMemberForAdmin(db: DbClient, memberId: string): Promise<MemberDetail | null> {
  const member = await findMemberById(db, memberId)
  if (!member) return null
  const [item, grants, sessions, connectedApps, events] = await Promise.all([
    listItemFor(db, member),
    listTagGrants(db, member.id),
    listMemberSessions(db, member.id),
    listConnectedMemberApps(db, member.id),
    listMemberEvents(db, member.id, 50),
  ])
  return {
    member: item,
    emailVerified: member.emailVerifiedAt !== null,
    profile: member.profile,
    grants,
    sessions,
    connectedApps: connectedApps.map((app) => ({
      id: app.id,
      name: app.name,
      device: app.device,
      connectedAt: app.connectedAt,
      lastUsedAt: app.lastUsedAt,
    })),
    events: events.map((event) => ({ kind: event.kind, createdAt: event.createdAt, ipAddress: event.ipAddress })),
  }
}

// ─── Invite ────────────────────────────────────────────────────────────────

export type InviteOutcome =
  | { ok: true; outcome: 'invited' | 'resent'; member: MemberListItem; link?: string }
  | { ok: false; reason: 'exists' | 'no_page' }

/**
 * Invite an address: create the member (no password, address unconfirmed),
 * give them the tags, and email a single-use link to choose a password. An
 * address whose account is still pending (invited, or signed up and never
 * confirmed) gets a fresh link; an address that
 * already has an account is refused.
 */
export async function inviteMember(
  db: DbClient,
  input: {
    email: string
    tags: readonly string[]
    linkOrigin: string
    /** Who the tags come from: `admin` (the default), or the id of the inviting plugin. */
    tagSource?: string
    /**
     * `email` (the default) mails the link. `link` mails nothing and returns
     * the link to the caller, for an admin to pass on by hand.
     */
    delivery?: 'email' | 'link'
  },
): Promise<InviteOutcome> {
  // An invitation is a link to a page of the site that accepts it. With no
  // such page there is nothing to invite anyone to.
  const pages = await getMemberPagePaths(db)
  if (!memberLinkPage(pages, 'invite')) return { ok: false, reason: 'no_page' }

  const existing = await findMemberByEmail(db, input.email)
  if (existing && (existing.status !== 'active' || !isPending(existing))) return { ok: false, reason: 'exists' }

  const member = existing ?? (await createMember(db, { email: input.email.trim(), passwordHash: null, profile: {}, verified: false }))
  // Lost a race with another invitation or a sign-up for the same address.
  if (!member) return { ok: false, reason: 'exists' }

  if (existing) {
    // The row may be a sign-up somebody else started with this address and
    // never confirmed. An invitation must not inherit what they typed: drop
    // their profile and their unused confirmation link.
    await setMemberProfile(db, existing.id, {})
    await withdrawMemberTokens(db, existing.id)
  }
  for (const tag of input.tags) {
    await grantMemberTag(db, { memberId: member.id, tag, source: input.tagSource ?? ADMIN_TAG_SOURCE, expiresAt: null })
  }
  const { token } = await issueMemberToken(db, member.id, 'invite')
  const link = memberTokenLink(input.linkOrigin, pages, 'invite', token)
  if (!link) return { ok: false, reason: 'no_page' }
  const byHand = input.delivery === 'link'
  if (!byHand) queueMemberMail(db, { kind: 'invite', to: member.email, link })
  await recordMemberEvent(db, member.id, 'invited', NO_REQUEST)
  return {
    ok: true,
    outcome: existing ? 'resent' : 'invited',
    member: await listItemFor(db, member),
    ...(byHand ? { link } : {}),
  }
}

// ─── Ensure (plugins) ──────────────────────────────────────────────────────

/**
 * The member with this address, created when there is none. For a plugin
 * that must give someone an account (a buyer, say) whether or not the site
 * can send email.
 *
 * A created member is like an invited one who has not accepted: active, no
 * password, address not confirmed (`pending` in the admin). Nothing is
 * emailed and no link is issued. They get in later through any flow that
 * proves the address: a sign-in link, a password reset, an invitation, or
 * signing up with that address.
 *
 * Safe to call twice at once: the partial unique index on the address
 * decides which insert wins, and the loser returns the winner's row. An
 * existing member is returned as it is, suspended included; nothing is
 * re-activated. A deleted member is anonymised (the address is gone from the
 * row), so it cannot be recognised and the address gets a fresh account.
 *
 * `tags` are granted from `source` with no end, except where `source`
 * already grants that tag and the grant is still active: that grant, and its
 * end date, stay as they are. An expired grant is replaced.
 */
export async function ensureMember(
  db: DbClient,
  input: { email: string; tags: readonly string[]; source: string },
): Promise<{ member: MemberRecord; created: boolean }> {
  let member = await findMemberByEmail(db, input.email)
  let created = false
  if (!member) {
    const fresh = await createMember(db, { email: input.email.trim(), passwordHash: null, profile: {}, verified: false })
    if (fresh) {
      member = fresh
      created = true
      await recordMemberEvent(db, fresh.id, 'created_by_plugin', NO_REQUEST, { plugin: input.source })
    } else {
      // Lost the race to another call for the same address: theirs is the member.
      member = await findMemberByEmail(db, input.email)
    }
  }
  if (!member) throw new Error('The member could not be created')
  for (const tag of input.tags) {
    await grantMemberTagIfAbsent(db, { memberId: member.id, tag, source: input.source })
  }
  return { member, created }
}

// ─── Changes to one member ─────────────────────────────────────────────────

/**
 * Suspend or restore a member. A suspended member cannot sign in, and every
 * open session stops working on its next request (`findMemberSession`
 * requires an active member). The sessions and unused links are also ended
 * for good, so restoring the member later does not bring them back: they
 * sign in again.
 */
export async function setMemberSuspended(db: DbClient, memberId: string, suspended: boolean): Promise<boolean> {
  const member = await findMemberById(db, memberId)
  if (!member) return false
  await db`
    update members set status = ${suspended ? 'suspended' : 'active'}, updated_at = ${nowIso()}
     where id = ${memberId} and deleted_at is null
  `
  if (suspended) {
    await revokeAllMemberSessions(db, memberId)
    await revokeAllMemberAppGrants(db, memberId)
    await withdrawMemberTokens(db, memberId)
  }
  await recordMemberEvent(db, memberId, suspended ? 'suspended' : 'unsuspended', NO_REQUEST)
  return true
}

/** End every session of a member, in browsers and in apps. They can sign in again. */
export async function signOutMemberEverywhere(db: DbClient, memberId: string): Promise<boolean> {
  if (!(await findMemberById(db, memberId))) return false
  await revokeAllMemberSessions(db, memberId)
  await revokeAllMemberAppGrants(db, memberId)
  await recordMemberEvent(db, memberId, 'signed_out_by_admin', NO_REQUEST)
  return true
}

/**
 * Sign a member out of one app and return the app's name. Null when that
 * approval is not this member's, or is already over.
 */
export async function disconnectMemberAppAsAdmin(db: DbClient, memberId: string, grantId: string): Promise<string | null> {
  const revoked = await revokeMemberAppGrant(db, memberId, grantId)
  if (!revoked) return null
  await recordMemberEvent(db, memberId, 'app_disconnected_by_admin', NO_REQUEST, { app: revoked.appName })
  return revoked.appName
}

/** Delete a member for good (see `anonymizeMember`). */
export async function deleteMemberAsAdmin(db: DbClient, memberId: string): Promise<boolean> {
  if (!(await findMemberById(db, memberId))) return false
  await recordMemberEvent(db, memberId, 'deleted', NO_REQUEST, { by: 'admin' })
  await anonymizeMember(db, memberId)
  await discardQueuedMailForMember(db, memberId)
  return true
}
