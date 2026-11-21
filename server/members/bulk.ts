/**
 * Every member at once: the export of all members (CSV or JSON, streamed a
 * page at a time) and the import of members from such a file (read, checked,
 * previewed, then applied).
 *
 * Like the rest of `server/members`, nothing here knows about admin users or
 * HTTP; the cms handler (`server/handlers/cms/members.ts`) decides who may
 * call these, and audits the call.
 *
 * Neither direction carries anything secret: no password hashes, sessions,
 * tokens, app sign-ins or IP addresses are written, and an import never sets
 * a password, a status or a confirmation. Plugins' sections of a member's
 * data are not in the bulk export: a plugin is asked about one member at a
 * time, which does not scale to every member. Each member's own export
 * (`exportMemberDataWithPlugins`) has them.
 */
import { MAIL_ADDRESS_PATTERN } from '@core/mail'
import {
  isGrantableMemberTag,
  MEMBER_CSV_COLUMNS,
  MEMBER_EMAIL_MAX_LENGTH,
  MEMBER_EXPORT_KIND,
  MEMBER_IMPORT_MAX_ROWS,
  MemberProfileSchema,
  type MemberExportFormat,
  type MemberImportProblem,
  type MemberImportResult,
  type MemberProfile,
  type MemberProfileField,
} from '@core/members'
import { isoDate } from '@core/utils/isoDate'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../db/client'
import { activeTagsFor, ADMIN_TAG_SOURCE, adminStatus, inviteMember, parameters, profileName } from './admin'
import { csvRecord, parseCsv } from './csv'
import {
  createMember,
  findMemberByEmail,
  grantMemberTagIfAbsent,
  normalizeMemberEmail,
  recordMemberEvent,
  setMemberProfile,
  type MemberRecord,
} from './repository'

/** Members read per query while exporting. */
const EXPORT_PAGE_SIZE = 500
/** Addresses looked up per query while importing. */
const LOOKUP_CHUNK = 500
/** Most problems a preview or result lists; the counts cover the rest. */
const MAX_LISTED_PROBLEMS = 100
const MAX_TAGS_PER_ROW = 50
const NAME_MAX = 200
const TEXT_MAX = 200
const TEXTAREA_MAX = 2000
const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)
const NO_REQUEST = { ipAddress: null, userAgent: null }

// ─── Export ────────────────────────────────────────────────────────────────

interface ExportRow {
  id: string
  email: string
  status: string
  password_hash: string | null
  email_verified_at: Date | string | null
  profile_json: unknown
  last_login_at: Date | string | null
  created_at: Date | string
}

/** One member as the bulk export writes it. Nothing secret. */
interface ExportedMember {
  email: string
  name: string
  status: string
  emailConfirmed: boolean
  tags: string[]
  createdAt: string
  lastSignInAt: string | null
  profile: MemberProfile
}

export async function countMembers(db: DbClient): Promise<number> {
  const { rows } = await db<{ total: number }>`select count(*) as total from members where deleted_at is null`
  return Number(rows[0]?.total ?? 0)
}

/**
 * One page of members after `afterId`, in id order. Paging by id (not by
 * offset) means a member created or deleted during the export never makes
 * another one appear twice or go missing.
 */
async function exportPage(db: DbClient, afterId: string): Promise<{ members: ExportedMember[]; lastId: string | null }> {
  const params = parameters(db)
  const after = params.add(afterId)
  const limit = params.add(EXPORT_PAGE_SIZE)
  const { rows } = await db.unsafe<ExportRow>(
    `select id, email, status, password_hash, email_verified_at, profile_json, last_login_at, created_at
       from members
      where deleted_at is null and id > ${after}
      order by id
      limit ${limit}`,
    params.values,
  )
  const tags = await activeTagsFor(db, rows.map((row) => row.id))
  const members = rows.map((row): ExportedMember => {
    const emailVerifiedAt = row.email_verified_at === null ? null : isoDate(row.email_verified_at)
    const parsedProfile = safeParseValue(MemberProfileSchema, row.profile_json)
    const profile = parsedProfile.ok ? parsedProfile.value : {}
    return {
      email: row.email,
      name: profileName(profile),
      status: adminStatus({
        status: row.status === 'suspended' ? 'suspended' : 'active',
        // Read only to tell `pending` apart; never written out.
        passwordHash: row.password_hash,
        emailVerifiedAt,
      }),
      emailConfirmed: emailVerifiedAt !== null,
      tags: tags.get(row.id) ?? [],
      createdAt: isoDate(row.created_at),
      lastSignInAt: row.last_login_at === null ? null : isoDate(row.last_login_at),
      profile,
    }
  })
  return { members, lastId: rows.length === EXPORT_PAGE_SIZE ? rows[rows.length - 1].id : null }
}

function csvLine(member: ExportedMember): string {
  return csvRecord([
    member.email,
    member.name,
    member.status,
    member.emailConfirmed ? 'true' : 'false',
    member.tags.join(' '),
    member.createdAt,
    member.lastSignInAt ?? '',
  ])
}

/**
 * Every live member as a CSV or JSON file, produced a page at a time as the
 * response is read, so the whole list is never in memory at once.
 */
export function memberExportStream(db: DbClient, format: MemberExportFormat): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let cursor: string | null = ''
  let first = true
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          format === 'csv'
            ? csvRecord(MEMBER_CSV_COLUMNS)
            : `{"kind":${JSON.stringify(MEMBER_EXPORT_KIND)},"version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},` +
                `"note":"Plugins' data is not included here. Each member's own data export includes it.","members":[`,
        ),
      )
    },
    async pull(controller) {
      try {
        // Every call must enqueue or close: a pull that does neither is never called again.
        const page = cursor === null ? null : await exportPage(db, cursor)
        if (page === null || page.members.length === 0) {
          if (format === 'json') controller.enqueue(encoder.encode(']}\n'))
          controller.close()
          return
        }
        cursor = page.lastId
        const text =
          format === 'csv'
            ? page.members.map(csvLine).join('')
            : page.members.map((member) => {
                const item = `${first ? '' : ','}\n${JSON.stringify(member)}`
                first = false
                return item
              }).join('')
        controller.enqueue(encoder.encode(text))
      } catch (err) {
        console.error('[members] the member export failed:', err)
        controller.error(err)
      }
    },
  })
}

// ─── Import: reading the file ──────────────────────────────────────────────

/** One row of the file that can be imported. */
export interface MemberImportRow {
  row: number
  email: string
  tags: string[]
  profile: MemberProfile
}

export type ParsedMemberImport =
  | { ok: true; rows: MemberImportRow[]; problems: MemberImportProblem[]; ignored: string[]; total: number }
  | { ok: false; error: string }

type RowInput = {
  row: number
  email: unknown
  name: unknown
  tags: unknown
  /** Profile values by field id, as read from the file. */
  profile: Record<string, unknown>
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', ''])

/** A profile value checked against its field, or the reason it does not fit. */
function profileValue(field: MemberProfileField, raw: unknown): { value: string | boolean } | { problem: string } {
  if (field.type === 'checkbox') {
    if (typeof raw === 'boolean') return { value: raw }
    const word = typeof raw === 'string' ? raw.trim().toLowerCase() : null
    if (word !== null && TRUE_WORDS.has(word)) return { value: true }
    if (word !== null && FALSE_WORDS.has(word)) return { value: false }
    return { problem: `"${field.id}" must be true or false` }
  }
  if (typeof raw !== 'string') return { problem: `"${field.id}" must be text` }
  const value = raw.trim()
  if (value.length > (field.type === 'textarea' ? TEXTAREA_MAX : TEXT_MAX)) return { problem: `"${field.id}" is too long` }
  return { value }
}

function tagList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return []
  if (typeof raw === 'string') return raw.split(/[\s,;|]+/).filter(Boolean)
  if (Array.isArray(raw) && raw.every((tag) => typeof tag === 'string')) return raw
  return null
}

/**
 * Check one row. The address must be valid, every tag one a member can be
 * given (`instatic:` tags are the system's own), and every profile value fit
 * its field.
 */
function readRow(
  input: RowInput,
  fields: ReadonlyMap<string, MemberProfileField>,
  extraTags: readonly string[],
): { row: MemberImportRow } | { problem: MemberImportProblem } {
  const email = typeof input.email === 'string' ? input.email.trim() : ''
  const problem = (reason: string) => ({ problem: { row: input.row, email: email.slice(0, MEMBER_EMAIL_MAX_LENGTH), reason } })
  if (!email) return problem('No email address')
  if (email.length > MEMBER_EMAIL_MAX_LENGTH || !ADDRESS_RE.test(email)) return problem('Not a valid email address')

  const ownTags = tagList(input.tags)
  if (ownTags === null) return problem('Tags must be a list of words')
  const tags = [...new Set([...ownTags.map((tag) => tag.trim().toLowerCase()), ...extraTags])]
  if (tags.length > MAX_TAGS_PER_ROW) return problem(`More than ${MAX_TAGS_PER_ROW} tags`)
  const refused = tags.find((tag) => !isGrantableMemberTag(tag))
  if (refused !== undefined) return problem(`The tag "${refused}" cannot be given to a member`)

  const profile: MemberProfile = {}
  for (const [id, raw] of Object.entries(input.profile)) {
    const field = fields.get(id)
    if (!field || raw === undefined || raw === null) continue
    const read = profileValue(field, raw)
    if ('problem' in read) return problem(read.problem)
    if (read.value !== '') profile[id] = read.value
  }
  if (input.name !== undefined && input.name !== null && input.name !== '') {
    if (typeof input.name !== 'string') return problem('The name must be text')
    const name = input.name.trim()
    if (name.length > NAME_MAX) return problem('The name is too long')
    if (name) profile.name = name
  }
  return { row: { row: input.row, email, tags, profile } }
}

/** Columns of the export that say how an account stands. An import never sets those. */
const ACCOUNT_COLUMNS = new Set(['status', 'email_confirmed', 'created_at', 'last_sign_in_at'])
const ACCOUNT_KEYS = new Set(['status', 'emailConfirmed', 'createdAt', 'lastSignInAt'])
/** Most columns a CSV import may have. */
const MAX_COLUMNS = 100
/** Most ignored column or key names a preview lists. */
const MAX_IGNORED = 30

function tooManyRows(count: number): string {
  return `The file has ${count.toLocaleString('en')} rows. One import takes at most ${MEMBER_IMPORT_MAX_ROWS.toLocaleString('en')}; split the file.`
}

function csvInputs(
  content: string,
  fields: ReadonlyMap<string, MemberProfileField>,
): { inputs: RowInput[]; ignored: string[] } | { error: string } {
  const records = parseCsv(content)
  if (!records) return { error: 'The file is not valid CSV: a quoted field is never closed.' }
  const [header, ...rows] = records
  if (!header) return { error: 'The file is empty.' }
  if (header.fields.length > MAX_COLUMNS) return { error: `The file has more than ${MAX_COLUMNS} columns.` }
  // Refused before any row is read further, so an oversized file costs one pass.
  if (rows.length > MEMBER_IMPORT_MAX_ROWS) return { error: tooManyRows(rows.length) }
  const columns = header.fields.map((name) => name.trim().toLowerCase())
  const emailAt = columns.indexOf('email')
  if (emailAt === -1) return { error: 'The file has no "email" column. The first line must name the columns.' }
  const nameAt = columns.indexOf('name')
  const tagsAt = columns.indexOf('tags')
  // Profile field ids are matched as written in the settings, other columns in any case.
  const fieldIds = new Map([...fields.keys()].map((id) => [id.toLowerCase(), id]))
  const profileColumns = columns.flatMap((name, index): Array<[number, string]> => {
    const id = fieldIds.get(name)
    return id && name !== 'name' && !ACCOUNT_COLUMNS.has(name) ? [[index, id]] : []
  })
  const ignored = columns.filter(
    (name) => name !== '' && !MEMBER_CSV_COLUMNS.some((column) => column === name) && !fieldIds.has(name),
  )
  const inputs = rows.map((record): RowInput => {
    const profile: Record<string, unknown> = {}
    for (const [index, id] of profileColumns) profile[id] = record.fields[index]
    return {
      row: record.line,
      email: record.fields[emailAt],
      name: nameAt === -1 ? undefined : record.fields[nameAt],
      tags: tagsAt === -1 ? undefined : record.fields[tagsAt],
      profile,
    }
  })
  return { inputs, ignored }
}

function jsonInputs(
  content: string,
  fields: ReadonlyMap<string, MemberProfileField>,
): { inputs: RowInput[]; ignored: string[] } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (_err) {
    // The reason is the answer: the file is not JSON.
    return { error: 'The file is not valid JSON.' }
  }
  const list: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && 'members' in parsed && Array.isArray(parsed.members)
      ? parsed.members
      : null
  if (!list) return { error: 'The file holds no list of members: expected a list, or an object with "members".' }
  if (list.length > MEMBER_IMPORT_MAX_ROWS) return { error: tooManyRows(list.length) }
  const ignored = new Set<string>()
  const known = new Set(['email', 'name', 'tags', 'profile'])
  const inputs = list.map((item, index): RowInput => {
    const row = index + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { row, email: undefined, name: undefined, tags: undefined, profile: {} }
    }
    const record: Record<string, unknown> = { ...item }
    for (const key of Object.keys(record)) if (!known.has(key) && !ACCOUNT_KEYS.has(key)) ignored.add(key)
    const profile: Record<string, unknown> = {}
    const given: Record<string, unknown> =
      record.profile && typeof record.profile === 'object' && !Array.isArray(record.profile) ? { ...record.profile } : {}
    for (const [key, value] of Object.entries(given)) {
      if (key === 'name') continue
      if (fields.has(key)) profile[key] = value
      else ignored.add(`profile.${key}`)
    }
    return { row, email: record.email, name: record.name ?? given.name, tags: record.tags, profile }
  })
  return { inputs, ignored: [...ignored] }
}

/**
 * Read an import file into rows that can be imported and rows that cannot
 * (with the reason). An address that appears twice is imported once; the
 * later row is reported. Only the owner's profile fields are read from it.
 */
export function parseMemberImport(
  format: MemberExportFormat,
  content: string,
  profileFields: readonly MemberProfileField[],
  extraTags: readonly string[],
): ParsedMemberImport {
  const fields = new Map(profileFields.map((field) => [field.id, field]))
  const read = format === 'csv' ? csvInputs(content, fields) : jsonInputs(content, fields)
  if ('error' in read) return { ok: false, error: read.error }
  if (read.inputs.length === 0) return { ok: false, error: 'The file has no members in it.' }
  const rows: MemberImportRow[] = []
  const problems: MemberImportProblem[] = []
  const seen = new Map<string, number>()
  for (const input of read.inputs) {
    const checked = readRow(input, fields, extraTags)
    if ('problem' in checked) {
      problems.push(checked.problem)
      continue
    }
    const key = normalizeMemberEmail(checked.row.email)
    const earlier = seen.get(key)
    if (earlier !== undefined) {
      problems.push({ row: input.row, email: checked.row.email, reason: `The address is already on row ${earlier}` })
      continue
    }
    seen.set(key, input.row)
    rows.push(checked.row)
  }
  return { ok: true, rows, problems, ignored: read.ignored.slice(0, MAX_IGNORED), total: read.inputs.length }
}

// ─── Import: what it would do, and doing it ────────────────────────────────

/** The normalised addresses among these that already have a live account. */
export async function existingMemberEmails(db: DbClient, rows: readonly MemberImportRow[]): Promise<Set<string>> {
  const found = new Set<string>()
  const emails = rows.map((row) => normalizeMemberEmail(row.email))
  for (let start = 0; start < emails.length; start += LOOKUP_CHUNK) {
    const params = parameters(db)
    const list = emails.slice(start, start + LOOKUP_CHUNK).map((email) => params.add(email)).join(', ')
    const { rows: matches } = await db.unsafe<{ email_normalized: string }>(
      `select email_normalized from members where deleted_at is null and email_normalized in (${list})`,
      params.values,
    )
    for (const match of matches) found.add(match.email_normalized)
  }
  return found
}

export function listedProblems(problems: readonly MemberImportProblem[]): MemberImportProblem[] {
  return problems.slice(0, MAX_LISTED_PROBLEMS)
}

let importRunning = false

function failureReason(created: 'invited' | 'created' | null): string {
  if (created === 'invited') return 'Invited, but the profile or the activity entry was not saved'
  if (created === 'created') {
    return 'The account was created, but not all of its tags were. Import the file again with "Add tags only"'
  }
  return 'Could not be saved. Import the file again to retry'
}

/** Whether an import is being applied right now; one runs at a time. */
export function memberImportRunning(): boolean {
  return importRunning
}

/** Give an existing member the row's tags (as an administrator's grant). Returns whether any was added. */
async function addTags(db: DbClient, member: MemberRecord, tags: readonly string[]): Promise<boolean> {
  let added = false
  for (const tag of tags) {
    if (await grantMemberTagIfAbsent(db, { memberId: member.id, tag, source: ADMIN_TAG_SOURCE })) {
      added = true
      await recordMemberEvent(db, member.id, 'tag_granted', NO_REQUEST, { tag })
    }
  }
  return added
}

/**
 * Import the rows, one at a time. A new address becomes a member like one a
 * plugin creates with `members.ensure`: active, no password, address not
 * confirmed (`pending`), and nothing emailed, unless `invite` is given, when
 * it is invited through the same path as the Invite button. An address that
 * has an account is skipped, or with `existing: 'tags'` given the row's
 * tags; its status, password, confirmation and profile are never touched.
 *
 * A row that fails is reported and the rest go on. Running the same file
 * again skips the members already created and, with `existing: 'tags'`,
 * adds only the tags that are missing; a row that failed after its account
 * was created says so in its reason.
 */
export async function applyMemberImport(
  db: DbClient,
  parsed: { rows: readonly MemberImportRow[]; problems: readonly MemberImportProblem[] },
  options: { existing: 'skip' | 'tags'; invite: { linkOrigin: string } | null },
): Promise<MemberImportResult> {
  if (importRunning) throw new Error('An import is already running')
  importRunning = true
  try {
    const result: MemberImportResult = {
      created: 0,
      invited: 0,
      tagged: 0,
      skipped: 0,
      invalid: parsed.problems.length,
      failed: 0,
      problems: [],
    }
    const failures: MemberImportProblem[] = []
    const existing = await existingMemberEmails(db, parsed.rows)

    const handleExisting = async (member: MemberRecord, row: MemberImportRow) => {
      if (options.existing === 'tags' && (await addTags(db, member, row.tags))) result.tagged++
      else result.skipped++
    }

    for (const row of parsed.rows) {
      // Set once the account exists: a failure after that leaves a member that a second
      // run with "leave them as they are" would skip, so the reason says what is missing.
      let created: 'invited' | 'created' | null = null
      try {
        if (existing.has(normalizeMemberEmail(row.email))) {
          const member = await findMemberByEmail(db, row.email)
          if (member) {
            await handleExisting(member, row)
            continue
          }
        }
        if (options.invite) {
          const invited = await inviteMember(db, { email: row.email, tags: row.tags, linkOrigin: options.invite.linkOrigin })
          if (!invited.ok) {
            const member = invited.reason === 'exists' ? await findMemberByEmail(db, row.email) : null
            if (member) {
              await handleExisting(member, row)
              continue
            }
            throw new Error(invited.reason === 'no_page' ? 'The invitation page is not set' : 'Could not be invited')
          }
          created = 'invited'
          if (Object.keys(row.profile).length > 0) await setMemberProfile(db, invited.member.id, row.profile)
          await recordMemberEvent(db, invited.member.id, 'imported', NO_REQUEST)
          result.created++
          result.invited++
          continue
        }
        const member = await createMember(db, { email: row.email, passwordHash: null, profile: row.profile, verified: false })
        if (!member) {
          // Someone signed up with the address between the check and now.
          const winner = await findMemberByEmail(db, row.email)
          if (!winner) throw new Error('The member could not be created')
          await handleExisting(winner, row)
          continue
        }
        created = 'created'
        await recordMemberEvent(db, member.id, 'imported', NO_REQUEST)
        for (const tag of row.tags) await grantMemberTagIfAbsent(db, { memberId: member.id, tag, source: ADMIN_TAG_SOURCE })
        result.created++
      } catch (err) {
        console.error('[members] an imported row could not be saved:', err)
        result.failed++
        failures.push({ row: row.row, email: row.email, reason: failureReason(created) })
      }
    }
    result.problems = listedProblems([...failures, ...parsed.problems])
    return result
  } finally {
    importRunning = false
  }
}
