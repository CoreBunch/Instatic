/**
 * Member accounts, tags, events and settings — all SQL for the `members`,
 * `member_tags`, `member_events` and `member_settings` tables.
 *
 * Sessions and single-use tokens have their own modules (`sessions.ts`,
 * `tokens.ts`). Nothing here knows about HTTP, cookies or admin users.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { emitMemberHook } from './hooks'
import { isoDate, isoDateOrNull, nowIso } from '@core/utils/isoDate'
import { Type, safeParseValue, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import {
  DEFAULT_MEMBER_SETTINGS,
  isGrantableMemberTag,
  MemberPagesSchema,
  MemberProfileFieldSchema,
  MemberProfileSchema,
  type CurrentMember,
  type MemberProfile,
  type MemberSettings,
  type MemberSignupMode,
} from '@core/members'

export type MemberStatus = 'active' | 'suspended' | 'deleted'

export interface MemberRecord {
  id: string
  email: string
  emailNormalized: string
  passwordHash: string | null
  status: MemberStatus
  emailVerifiedAt: string | null
  profile: MemberProfile
  lastLoginAt: string | null
  createdAt: string
}

interface MemberRow {
  id: string
  email: string
  email_normalized: string
  password_hash: string | null
  status: string
  email_verified_at: Date | string | null
  profile_json: unknown
  last_login_at: Date | string | null
  created_at: Date | string
}

const MEMBER_COLUMNS = `id, email, email_normalized, password_hash, status, email_verified_at,
  profile_json, last_login_at, created_at`

/** Validate a `*_json` column (both adapters hand it back already parsed). */
function readJsonColumn<T extends TSchema>(schema: T, value: unknown, fallback: Static<T>): Static<T> {
  const parsed = safeParseValue(schema, value)
  return parsed.ok ? parsed.value : fallback
}

function rowToMember(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    email: row.email,
    emailNormalized: row.email_normalized,
    passwordHash: row.password_hash,
    status: row.status as MemberStatus,
    emailVerifiedAt: isoDateOrNull(row.email_verified_at),
    profile: readJsonColumn(MemberProfileSchema, row.profile_json, {}),
    lastLoginAt: isoDateOrNull(row.last_login_at),
    createdAt: isoDate(row.created_at),
  }
}

export function normalizeMemberEmail(email: string): string {
  return email.trim().toLowerCase()
}

// ─── Members ───────────────────────────────────────────────────────────────

export async function findMemberByEmail(db: DbClient, email: string): Promise<MemberRecord | null> {
  const { rows } = await db.unsafe<MemberRow>(
    `select ${MEMBER_COLUMNS} from members where email_normalized = ${p(db, 1)} and deleted_at is null`,
    [normalizeMemberEmail(email)],
  )
  return rows[0] ? rowToMember(rows[0]) : null
}

export async function findMemberById(db: DbClient, id: string): Promise<MemberRecord | null> {
  const { rows } = await db.unsafe<MemberRow>(
    `select ${MEMBER_COLUMNS} from members where id = ${p(db, 1)} and deleted_at is null`,
    [id],
  )
  return rows[0] ? rowToMember(rows[0]) : null
}

function p(db: DbClient, index: number): string {
  return db.dialect === 'postgres' ? `$${index}` : '?'
}

interface CreateMemberInput {
  email: string
  passwordHash: string | null
  profile: MemberProfile
  verified: boolean
}

/**
 * Insert a member. Returns null when the email is already taken by a live
 * member (the partial unique index decides, so two racing sign-ups cannot
 * both win).
 */
export async function createMember(db: DbClient, input: CreateMemberInput): Promise<MemberRecord | null> {
  const id = nanoid()
  const now = nowIso()
  const email = input.email.trim()
  try {
    await db`
      insert into members (
        id, email, email_normalized, password_hash, status, email_verified_at,
        profile_json, created_at, updated_at
      ) values (
        ${id}, ${email}, ${normalizeMemberEmail(email)}, ${input.passwordHash}, 'active',
        ${input.verified ? now : null}, ${input.profile}, ${now}, ${now}
      )
    `
  } catch (err) {
    if (await findMemberByEmail(db, email)) return null
    throw err
  }
  emitMemberHook('member.created', { memberId: id, email })
  if (input.verified) emitMemberHook('member.verified', { memberId: id, email })
  return findMemberById(db, id)
}

export async function markMemberVerified(db: DbClient, memberId: string): Promise<void> {
  const now = nowIso()
  const { rows } = await db<{ email: string }>`
    update members set email_verified_at = ${now}, updated_at = ${now}
     where id = ${memberId} and email_verified_at is null
    returning email
  `
  // Only the first confirmation is an event.
  if (rows[0]) emitMemberHook('member.verified', { memberId, email: rows[0].email })
}

export async function markMemberLoggedIn(db: DbClient, memberId: string): Promise<void> {
  const now = nowIso()
  await db`update members set last_login_at = ${now}, updated_at = ${now} where id = ${memberId}`
}

export async function setMemberPasswordHash(db: DbClient, memberId: string, hash: string): Promise<void> {
  await db`update members set password_hash = ${hash}, updated_at = ${nowIso()} where id = ${memberId}`
}

export async function setMemberProfile(db: DbClient, memberId: string, profile: MemberProfile): Promise<void> {
  await db`
    update members set profile_json = ${profile}, updated_at = ${nowIso()}
     where id = ${memberId}
  `
}

/**
 * Move a member to a new, verified address. Returns false when another live
 * member took the address in the meantime.
 */
export async function setMemberEmail(db: DbClient, memberId: string, email: string): Promise<boolean> {
  const now = nowIso()
  try {
    await db`
      update members
         set email = ${email.trim()}, email_normalized = ${normalizeMemberEmail(email)},
             email_verified_at = ${now}, updated_at = ${now}
       where id = ${memberId}
    `
    return true
  } catch (err) {
    const holder = await findMemberByEmail(db, email)
    if (holder && holder.id !== memberId) return false
    throw err
  }
}

/**
 * Soft-delete and anonymise: the row stays (so ids in plugin data and events
 * keep resolving to "a deleted member") but nothing identifying remains, and
 * the address is free to register again.
 */
export async function anonymizeMember(db: DbClient, memberId: string): Promise<void> {
  const now = nowIso()
  const placeholder = `deleted+${memberId}@invalid`
  await db.transaction(async (tx) => {
    await tx`delete from member_sessions where member_id = ${memberId}`
    await tx`delete from member_tokens where member_id = ${memberId}`
    await tx`delete from member_app_pairs where email_member_id = ${memberId}`
    // Sign-ins to apps go with the account, and with them the device names
    // the apps gave ("Ada's MacBook").
    await tx`
      delete from member_app_tokens
       where grant_id in (select id from member_app_grants where member_id = ${memberId})
    `
    await tx`
      delete from member_app_codes
       where grant_id in (select id from member_app_grants where member_id = ${memberId})
    `
    await tx`delete from member_app_grants where member_id = ${memberId}`
    await tx`delete from member_tags where member_id = ${memberId}`
    await tx`
      update member_events set ip_address = null, user_agent = null, metadata_json = '{}'
       where member_id = ${memberId}
    `
    await tx`
      update members
         set email = ${placeholder}, email_normalized = ${placeholder}, password_hash = null,
             status = 'deleted', profile_json = '{}', email_verified_at = null,
             deleted_at = ${now}, updated_at = ${now}
       where id = ${memberId}
    `
  })
  emitMemberHook('member.deleted', { memberId })
}

/**
 * Members deleted after a point, oldest deletion first, ordered by
 * (deleted_at, id) so deletions in the same instant still page cleanly.
 * `after` is the last one the caller saw, or null for the start.
 */
export async function listDeletedMembersSince(
  db: DbClient,
  after: { deletedAt: string; id: string } | null,
  limit: number,
): Promise<Array<{ id: string; deletedAt: string }>> {
  const { rows } = after
    ? await db<{ id: string; deleted_at: Date | string }>`
        select id, deleted_at from members
         where deleted_at is not null
           and (deleted_at > ${after.deletedAt} or (deleted_at = ${after.deletedAt} and id > ${after.id}))
         order by deleted_at, id
         limit ${limit}
      `
    : await db<{ id: string; deleted_at: Date | string }>`
        select id, deleted_at from members
         where deleted_at is not null
         order by deleted_at, id
         limit ${limit}
      `
  return rows.map((row) => ({ id: row.id, deletedAt: isoDate(row.deleted_at) }))
}

// ─── Tags ──────────────────────────────────────────────────────────────────

/** Tags the member holds right now: granted by any source and not expired. */
export async function listActiveMemberTags(db: DbClient, memberId: string): Promise<string[]> {
  const { rows } = await db<{ tag: string }>`
    select distinct tag from member_tags
     where member_id = ${memberId} and (expires_at is null or expires_at > ${nowIso()})
     order by tag
  `
  return rows.map((row) => row.tag)
}

/**
 * The tags a member holds right now, each with the moment it runs out (null
 * when it does not). A tag granted by several sources lasts as long as its
 * longest grant.
 */
export async function listActiveMemberTagExpiries(
  db: DbClient,
  memberId: string,
): Promise<Array<{ tag: string; expiresAt: string | null }>> {
  const { rows } = await db<{ tag: string; expires_at: string | null }>`
    select tag, expires_at from member_tags
     where member_id = ${memberId} and (expires_at is null or expires_at > ${nowIso()})
     order by tag
  `
  const expiries = new Map<string, string | null>()
  for (const row of rows) {
    const known = expiries.get(row.tag)
    if (known === undefined) expiries.set(row.tag, row.expires_at)
    else if (known !== null && (row.expires_at === null || row.expires_at > known)) expiries.set(row.tag, row.expires_at)
  }
  return [...expiries].map(([tag, expiresAt]) => ({ tag, expiresAt }))
}

/**
 * Grant (or refresh) one tag from one source. The key is (member, tag,
 * source): granting `pro` from a plugin never touches a `pro` an admin gave.
 */
export async function grantMemberTag(
  db: DbClient,
  input: { memberId: string; tag: string; source: string; expiresAt: string | null },
): Promise<void> {
  if (!isGrantableMemberTag(input.tag)) throw new Error(`"${input.tag}" is not a tag a member can be given`)
  await db`
    insert into member_tags (member_id, tag, source, expires_at, created_at)
    values (${input.memberId}, ${input.tag}, ${input.source}, ${input.expiresAt}, ${nowIso()})
    on conflict (member_id, tag, source) do update set expires_at = excluded.expires_at
  `
  emitMemberHook('member.tagged', {
    memberId: input.memberId,
    tag: input.tag,
    source: input.source,
    expiresAt: input.expiresAt,
  })
}

/**
 * Grant a tag from one source, with no end, unless that source already
 * grants it and the grant is still active. An active grant keeps its end
 * date: a repeated call neither extends nor shortens it. An expired one is
 * replaced. Returns whether a grant was added or replaced.
 */
export async function grantMemberTagIfAbsent(
  db: DbClient,
  input: { memberId: string; tag: string; source: string },
): Promise<boolean> {
  if (!isGrantableMemberTag(input.tag)) throw new Error(`"${input.tag}" is not a tag a member can be given`)
  const now = nowIso()
  const { rows } = await db<{ tag: string }>`
    insert into member_tags (member_id, tag, source, expires_at, created_at)
    values (${input.memberId}, ${input.tag}, ${input.source}, ${null}, ${now})
    on conflict (member_id, tag, source) do update
      set expires_at = excluded.expires_at, created_at = excluded.created_at
      where member_tags.expires_at is not null and member_tags.expires_at <= ${now}
    returning tag
  `
  if (rows.length === 0) return false
  emitMemberHook('member.tagged', { memberId: input.memberId, tag: input.tag, source: input.source, expiresAt: null })
  return true
}

/** Withdraw one source's grant of a tag. Other sources' grants stay. */
export async function revokeMemberTag(
  db: DbClient,
  input: { memberId: string; tag: string; source: string },
): Promise<void> {
  await db`
    delete from member_tags
     where member_id = ${input.memberId} and tag = ${input.tag} and source = ${input.source}
  `
}

export async function toCurrentMember(db: DbClient, member: MemberRecord): Promise<CurrentMember> {
  return {
    id: member.id,
    email: member.email,
    emailVerified: member.emailVerifiedAt !== null,
    profile: member.profile,
    tags: await listActiveMemberTags(db, member.id),
    hasPassword: member.passwordHash !== null,
    createdAt: member.createdAt,
  }
}

// ─── Events ────────────────────────────────────────────────────────────────

export type MemberEventKind =
  | 'signup'
  | 'verified'
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'magic_link_requested'
  | 'password_reset_requested'
  | 'password_reset'
  | 'password_changed'
  | 'email_change_requested'
  | 'email_changed'
  | 'profile_updated'
  | 'deleted'
  | 'app_connected'
  | 'app_disconnected'
  // Done by a plugin (`metadata.plugin` names it), not by the member.
  | 'created_by_plugin'
  // Done by an administrator, not by the member.
  | 'invited'
  | 'suspended'
  | 'unsuspended'
  | 'signed_out_by_admin'
  | 'app_disconnected_by_admin'
  | 'tag_granted'
  | 'tag_revoked'

export interface MemberEventContext {
  ipAddress: string | null
  userAgent: string | null
}

export async function recordMemberEvent(
  db: DbClient,
  memberId: string | null,
  kind: MemberEventKind,
  context: MemberEventContext,
  metadata: Record<string, string> = {},
): Promise<void> {
  await db`
    insert into member_events (id, member_id, kind, ip_address, user_agent, metadata_json, created_at)
    values (
      ${nanoid()}, ${memberId}, ${kind}, ${context.ipAddress},
      ${context.userAgent?.slice(0, 300) ?? null}, ${metadata}, ${nowIso()}
    )
  `
}

export interface MemberEventRecord {
  kind: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}

export async function listMemberEvents(db: DbClient, memberId: string, limit = 200): Promise<MemberEventRecord[]> {
  const { rows } = await db<{ kind: string; ip_address: string | null; user_agent: string | null; created_at: Date | string }>`
    select kind, ip_address, user_agent, created_at from member_events
     where member_id = ${memberId}
     order by created_at desc, id desc
     limit ${limit}
  `
  return rows.map((row) => ({
    kind: row.kind,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: isoDate(row.created_at),
  }))
}

// ─── Settings ──────────────────────────────────────────────────────────────

const SETTINGS_ROW_ID = 'default'
const ProfileFieldsSchema = Type.Array(MemberProfileFieldSchema)

export async function getMemberSettings(db: DbClient): Promise<MemberSettings> {
  const { rows } = await db<{ signup_mode: string; profile_fields_json: unknown; pages_json: unknown }>`
    select signup_mode, profile_fields_json, pages_json from member_settings where id = ${SETTINGS_ROW_ID}
  `
  const row = rows[0]
  if (!row) return DEFAULT_MEMBER_SETTINGS
  const signupMode: MemberSignupMode =
    row.signup_mode === 'open' || row.signup_mode === 'invite' ? row.signup_mode : 'closed'
  return {
    signupMode,
    profileFields: readJsonColumn(
      ProfileFieldsSchema,
      row.profile_fields_json,
      DEFAULT_MEMBER_SETTINGS.profileFields,
    ),
    pages: readJsonColumn(MemberPagesSchema, row.pages_json, {}),
  }
}

export async function saveMemberSettings(db: DbClient, settings: MemberSettings): Promise<void> {
  await db`
    insert into member_settings (id, signup_mode, profile_fields_json, pages_json, updated_at)
    values (
      ${SETTINGS_ROW_ID}, ${settings.signupMode}, ${settings.profileFields},
      ${settings.pages}, ${nowIso()}
    )
    on conflict (id) do update set
      signup_mode = excluded.signup_mode,
      profile_fields_json = excluded.profile_fields_json,
      pages_json = excluded.pages_json,
      updated_at = excluded.updated_at
  `
}
