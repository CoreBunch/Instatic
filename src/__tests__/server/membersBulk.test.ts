/**
 * Exporting every member and importing members from a file
 * (`/admin/api/cms/members/export`, `/import/preview`, `/import`): who may
 * call them, what the files hold (and never hold), and what an import does
 * to new and existing addresses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { nanoid } from 'nanoid'
import {
  DEFAULT_MEMBER_SETTINGS,
  MEMBER_IMPORT_MAX_INVITATIONS,
  MEMBER_IMPORT_MAX_ROWS,
  type MemberImportPreview,
  type MemberImportResult,
} from '@core/members'
import { nowIso } from '@core/utils/isoDate'
import { resetPublicOrigins } from '../../../server/auth/security'
import { flushMemberMail } from '../../../server/members/mail'
import { resetMemberLimits } from '../../../server/members/limits'
import {
  createMember,
  findMemberByEmail,
  grantMemberTag,
  listActiveMemberTags,
  listMemberEvents,
  recordMemberEvent,
  saveMemberSettings,
} from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { setMemberSuspended } from '../../../server/members/admin'
import { issueMemberToken } from '../../../server/members/tokens'
import { parseCsv } from '../../../server/members/csv'
import { handleCmsRequest } from '../../../server/handlers/cms'
import {
  createCapabilityTestHarness,
  expectForbidden,
  expectStepUpRequired,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { publishMemberPages } from '../helpers/memberPages'

const BASE = '/admin/api/cms/members'
const HASH = '$argon2id$v=19$m=65536,t=2,p=1$SECRET-HASH'
const IP = '203.0.113.77'

describe('bulk member export and import', () => {
  let h: CapabilityTestHarness
  let owner: string

  beforeEach(async () => {
    h = await createCapabilityTestHarness()
    resetMemberLimits()
    resetPublicOrigins()
    owner = await h.setupOwner()
  })

  afterEach(async () => {
    await flushMemberMail()
    resetPublicOrigins()
    await h.cleanup()
  })

  async function member(email: string, options: { name?: string; tags?: string[]; pending?: boolean } = {}) {
    const created = await createMember(h.db, {
      email,
      passwordHash: options.pending ? null : HASH,
      profile: options.name ? { name: options.name } : {},
      verified: !options.pending,
    })
    for (const tag of options.tags ?? []) {
      await grantMemberTag(h.db, { memberId: created!.id, tag, source: 'admin', expiresAt: null })
    }
    return created!
  }

  const exportAll = (format: string, init: { cookie?: string } = {}) =>
    h.cms(`${BASE}/export?format=${format}`, { cookie: init.cookie ?? owner })

  const importBody = (content: string, extra: Record<string, unknown> = {}) => ({
    format: 'csv',
    content,
    existing: 'skip',
    tags: [],
    invite: false,
    ...extra,
  })
  const preview = async (content: string, extra: Record<string, unknown> = {}, cookie = owner) => {
    const res = await h.cms(`${BASE}/import/preview`, { method: 'POST', cookie, json: importBody(content, extra) })
    expect(res.status).toBe(200)
    return (await readJson<{ preview: MemberImportPreview }>(res)).preview
  }
  const apply = (content: string, extra: Record<string, unknown> = {}, cookie = owner) =>
    h.cms(`${BASE}/import`, { method: 'POST', cookie, json: importBody(content, extra) })
  const applied = async (content: string, extra: Record<string, unknown> = {}) => {
    const res = await apply(content, extra)
    expect(res.status).toBe(200)
    return (await readJson<{ result: MemberImportResult }>(res)).result
  }

  describe('who may call it', () => {
    it('refuses anyone without members.manage, and a reader too', async () => {
      const editor = await h.createRoleUser({ name: 'Editor', slug: 'editor', capabilities: ['site.read'] })
      const reader = await h.createRoleUser({ name: 'Viewer', slug: 'viewer', capabilities: ['members.read'] })
      for (const cookie of [editor.cookie, reader.cookie]) {
        await expectForbidden(await exportAll('csv', { cookie }))
        await expectForbidden(await h.cms(`${BASE}/import/preview`, { method: 'POST', cookie, json: importBody('email\na@example.com') }))
        await expectForbidden(await apply('email\na@example.com', {}, cookie))
      }
    })

    it('asks a manager for the password again before exporting or importing, not before a preview', async () => {
      const manager = await h.createRoleUser({ name: 'Manager', slug: 'manager', capabilities: ['members.manage'] })
      await expectStepUpRequired(await exportAll('csv', { cookie: manager.cookie }))
      await expectStepUpRequired(await apply('email\na@example.com', {}, manager.cookie))
      expect(await findMemberByEmail(h.db, 'a@example.com')).toBeNull()
      expect((await preview('email\na@example.com', {}, manager.cookie)).new).toBe(1)

      const stepped = await h.stepUp(manager.cookie)
      expect((await exportAll('csv', { cookie: stepped })).status).toBe(200)
      expect((await apply('email\na@example.com', {}, stepped)).status).toBe(200)
    })

    it('refuses a request another site started', async () => {
      // Set after construction: the test DOM's Request drops a Sec- header given in its init.
      const crossSite = (path: string, init: RequestInit = {}) => {
        const req = new Request(`http://localhost${BASE}${path}`, init)
        req.headers.set('cookie', owner)
        req.headers.set('sec-fetch-site', 'cross-site')
        return handleCmsRequest(req, h.db)
      }
      expect((await crossSite('/export?format=csv')).status).toBe(403)
      for (const path of ['/import/preview', '/import']) {
        const res = await crossSite(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(importBody('email\na@example.com')),
        })
        expect(res.status).toBe(403)
      }
      expect(await findMemberByEmail(h.db, 'a@example.com')).toBeNull()
    })

    it('limits exports and imports per administrator', async () => {
      for (let i = 0; i < 5; i++) expect((await exportAll('csv')).status).toBe(200)
      const limited = await exportAll('json')
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)

      for (let i = 0; i < 10; i++) expect((await apply(`email\nperson${i}@example.com`)).status).toBe(200)
      expect((await apply('email\nlate@example.com')).status).toBe(429)
      expect(await findMemberByEmail(h.db, 'late@example.com')).toBeNull()
    })
  })

  describe('export', () => {
    it('writes every member as CSV with nothing secret, safe for a spreadsheet', async () => {
      const ada = await member('ada@example.com', { name: 'Ada Lovelace', tags: ['pro', 'vip'] })
      await member('pending@example.com', { pending: true })
      const linus = await member('linus@example.com', { name: '=HYPERLINK("http://evil")' })
      await setMemberSuspended(h.db, linus.id, true)
      const session = await createMemberSession(h.db, ada.id, { ipAddress: IP, userAgent: 'Secret-Agent/1' })
      const { token } = await issueMemberToken(h.db, ada.id, 'magic')
      await recordMemberEvent(h.db, ada.id, 'login', { ipAddress: IP, userAgent: 'Secret-Agent/1' })

      const res = await exportAll('csv')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('content-type')).toContain('text/csv')
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="members-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      const text = await res.text()
      for (const secret of [HASH, 'SECRET-HASH', IP, 'Secret-Agent', session.token, token]) expect(text).not.toContain(secret)

      const rows = parseCsv(text)!
      expect(rows[0].fields).toEqual(['email', 'name', 'status', 'email_confirmed', 'tags', 'created_at', 'last_sign_in_at'])
      const byEmail = new Map(rows.slice(1).map((row) => [row.fields[0], row.fields]))
      expect(byEmail.get('ada@example.com')?.slice(1, 5)).toEqual(['Ada Lovelace', 'active', 'true', 'pro vip'])
      expect(byEmail.get('pending@example.com')?.slice(2, 4)).toEqual(['pending', 'false'])
      expect(byEmail.get('linus@example.com')?.[2]).toBe('suspended')
      // The raw text starts the name with a quote mark; reading it back gives the name as typed.
      expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`)
      expect(byEmail.get('linus@example.com')?.[1]).toBe('=HYPERLINK("http://evil")')

      const { rows: audit } = await h.db<{ action: string; metadata_json: unknown }>`
        select action, metadata_json from audit_events where action = 'member.export_all'
      `
      expect(audit).toHaveLength(1)
      expect(JSON.stringify(audit[0].metadata_json)).toContain('"count":"3"')
    })

    it('writes JSON with the profile fields and a note about plugin data', async () => {
      await member('ada@example.com', { name: 'Ada', tags: ['pro'] })
      const res = await exportAll('json')
      expect(res.headers.get('content-disposition')).toContain('.json"')
      const text = await res.text()
      expect(text).not.toContain(HASH)
      const body = JSON.parse(text) as { kind: string; note: string; members: Array<Record<string, unknown>> }
      expect(body.kind).toBe('instatic.members')
      expect(body.note).toContain('Plugins')
      expect(body.members).toEqual([
        expect.objectContaining({ email: 'ada@example.com', name: 'Ada', status: 'active', emailConfirmed: true, tags: ['pro'], profile: { name: 'Ada' } }),
      ])
      expect(Object.keys(body.members[0]).sort()).toEqual(
        ['createdAt', 'email', 'emailConfirmed', 'lastSignInAt', 'name', 'profile', 'status', 'tags'],
      )
    })

    it('refuses an unknown format', async () => {
      expect((await exportAll('xlsx')).status).toBe(400)
    })

    it('streams a large export page by page, every member once', async () => {
      const total = 1_234
      const now = nowIso()
      for (let start = 0; start < total; start += 200) {
        await h.db.transaction(async (tx) => {
          for (let i = start; i < Math.min(total, start + 200); i++) {
            const email = `member${i}@example.com`
            await tx`
              insert into members (id, email, email_normalized, password_hash, status, profile_json, created_at, updated_at)
              values (${nanoid()}, ${email}, ${email}, ${HASH}, 'active', ${{}}, ${now}, ${now})
            `
          }
        })
      }
      const res = await exportAll('json')
      expect(res.body).toBeInstanceOf(ReadableStream)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let chunks = 0
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks++
        text += decoder.decode(value, { stream: true })
      }
      // A header, three pages of 500 and the closing bracket: never one chunk holding everyone.
      expect(chunks).toBeGreaterThanOrEqual(4)
      const emails = (JSON.parse(text) as { members: Array<{ email: string }> }).members.map((entry) => entry.email)
      expect(emails).toHaveLength(total)
      expect(new Set(emails).size).toBe(total)
      expect(text).not.toContain(HASH)
    })
  })

  describe('import', () => {
    it('previews new, existing and invalid rows and changes nothing', async () => {
      await member('ada@example.com')
      const csv = [
        'Email,Name,tags,status,favourite_colour',
        'new@example.com,New Person,student,suspended,blue',
        'ADA@example.com,Ada,,',
        'not-an-address,Nobody,,',
        'reserved@example.com,,instatic:admin,',
        'new@example.com,Twice,,',
        ',,,',
      ].join('\r\n')
      const result = await preview(csv)
      expect(result).toMatchObject({ rows: 6, new: 1, existing: 1, invalid: 4, ignored: ['favourite_colour'] })
      expect(result.problems.map((problem) => [problem.row, problem.reason])).toEqual([
        [4, 'Not a valid email address'],
        [5, 'The tag "instatic:admin" cannot be given to a member'],
        [6, 'The address is already on row 2'],
        [7, 'No email address'],
      ])
      expect(await findMemberByEmail(h.db, 'new@example.com')).toBeNull()
    })

    it('creates pending members with no password, sends nothing, and leaves existing members alone', async () => {
      const ada = await member('ada@example.com', { name: 'Ada', tags: ['pro'] })
      await setMemberSuspended(h.db, ada.id, true)
      const result = await applied(
        'email,name,tags\r\nnew@example.com,New Person,student vip\r\nada@example.com,Changed,student\r\nbad,,\r\n',
        { tags: ['imported-2026'] },
      )
      expect(result).toMatchObject({ created: 1, invited: 0, tagged: 0, skipped: 1, invalid: 1, failed: 0 })

      const created = await findMemberByEmail(h.db, 'new@example.com')
      expect(created).toMatchObject({ passwordHash: null, emailVerifiedAt: null, status: 'active', profile: { name: 'New Person' } })
      expect((await listActiveMemberTags(h.db, created!.id)).sort()).toEqual(['imported-2026', 'student', 'vip'])
      expect((await listMemberEvents(h.db, created!.id)).map((event) => event.kind)).toContain('imported')

      const after = await findMemberByEmail(h.db, 'ada@example.com')
      expect(after).toMatchObject({ status: 'suspended', passwordHash: HASH, profile: { name: 'Ada' } })
      expect(await listActiveMemberTags(h.db, ada.id)).toEqual(['pro'])

      await flushMemberMail()
      const { rows: mails } = await h.db<{ id: string }>`select id from mail_outbox`
      expect(mails).toHaveLength(0)

      const { rows: audit } = await h.db<{ metadata_json: unknown }>`select metadata_json from audit_events where action = 'member.import'`
      expect(audit[0]?.metadata_json).toMatchObject({ created: '1', skipped: '1', invalid: '1', failed: '0' })
    })

    it('adds only tags to existing members when asked, and never their status, password or confirmation', async () => {
      const ada = await member('ada@example.com', { tags: ['pro'] })
      const pending = await member('pending@example.com', { pending: true })
      const result = await applied('email,tags\nada@example.com,student pro\npending@example.com,\n', { existing: 'tags', tags: ['club'] })
      expect(result).toMatchObject({ created: 0, tagged: 2, skipped: 0 })
      expect((await listActiveMemberTags(h.db, ada.id)).sort()).toEqual(['club', 'pro', 'student'])
      expect(await findMemberByEmail(h.db, 'ada@example.com')).toMatchObject({ passwordHash: HASH, status: 'active' })
      expect(await findMemberByEmail(h.db, 'pending@example.com')).toMatchObject({ passwordHash: null, emailVerifiedAt: null })
      expect(await listActiveMemberTags(h.db, pending.id)).toEqual(['club'])

      // Importing the same file again changes nothing more.
      expect(await applied('email,tags\nada@example.com,student pro\n', { existing: 'tags', tags: ['club'] })).toMatchObject({ tagged: 0, skipped: 1 })
    })

    it('reads back its own JSON export, profile fields included', async () => {
      await saveMemberSettings(h.db, {
        ...DEFAULT_MEMBER_SETTINGS,
        profileFields: [
          { id: 'company', label: 'Company', type: 'text', required: false },
          { id: 'newsletter', label: 'Newsletter', type: 'checkbox', required: false },
        ],
      })
      const content = JSON.stringify({
        kind: 'instatic.members',
        members: [
          { email: 'grace@example.com', name: 'Grace', status: 'active', tags: ['navy'], profile: { company: 'Navy', newsletter: true, secret: 'x' }, password: 'nope' },
          { email: 'bad@example.com', profile: { newsletter: 'maybe' } },
        ],
      })
      const checked = await preview(content, { format: 'json' })
      expect(checked).toMatchObject({ new: 1, invalid: 1, ignored: ['password', 'profile.secret'] })
      expect(checked.problems[0].reason).toBe('"newsletter" must be true or false')

      expect(await applied(content, { format: 'json' })).toMatchObject({ created: 1, invalid: 1 })
      const grace = await findMemberByEmail(h.db, 'grace@example.com')
      expect(grace?.profile).toEqual({ name: 'Grace', company: 'Navy', newsletter: true })
      expect(grace?.passwordHash).toBeNull()
    })

    it('imports a CSV export as it was written', async () => {
      await member('ada@example.com', { name: '-Ada', tags: ['pro'] })
      const csv = await (await exportAll('csv')).text()
      const other = await createCapabilityTestHarness()
      try {
        const otherOwner = await other.setupOwner()
        const res = await other.cms(`${BASE}/import`, { method: 'POST', cookie: otherOwner, json: importBody(csv) })
        expect((await readJson<{ result: MemberImportResult }>(res)).result.created).toBe(1)
        const copy = await findMemberByEmail(other.db, 'ada@example.com')
        // An exported account comes in pending: a password and a confirmation are never imported.
        expect(copy).toMatchObject({ profile: { name: '-Ada' }, passwordHash: null, emailVerifiedAt: null })
        expect(await listActiveMemberTags(other.db, copy!.id)).toEqual(['pro'])
      } finally {
        await other.cleanup()
      }
    })

    it('invites new members only when the site can, and through the invitation path', async () => {
      const unavailable = await preview('email\nnew@example.com', { invite: true })
      expect(unavailable.invitations.available).toBe(false)
      expect(unavailable.invitations.reason).toContain('Accept an invitation')
      const refused = await apply('email\nnew@example.com', { invite: true })
      expect(refused.status).toBe(409)
      expect(await findMemberByEmail(h.db, 'new@example.com')).toBeNull()

      await saveMemberSettings(h.db, { ...DEFAULT_MEMBER_SETTINGS, pages: await publishMemberPages(h.db, { invite: '/invitation' }) })
      expect((await preview('email\nnew@example.com', { invite: true })).invitations.available).toBe(true)
      expect(await applied('email,tags\nnew@example.com,student', { invite: true })).toMatchObject({ created: 1, invited: 1 })
      const created = await findMemberByEmail(h.db, 'new@example.com')
      expect(created?.passwordHash).toBeNull()
      expect(await listActiveMemberTags(h.db, created!.id)).toEqual(['student'])
      await flushMemberMail()
      const { rows } = await h.db<{ to_address: string }>`select to_address from mail_outbox where kind = 'member.invite'`
      expect(rows.map((row) => row.to_address)).toEqual(['new@example.com'])

      const many = ['email', ...Array.from({ length: MEMBER_IMPORT_MAX_INVITATIONS + 1 }, (_, i) => `p${i}@example.com`)].join('\n')
      expect((await preview(many, { invite: true })).invitations.available).toBe(false)
      expect((await apply(many, { invite: true })).status).toBe(409)
    })

    it('refuses an unreadable file, too many rows, a file that is too large and reserved extra tags', async () => {
      const problem = async (body: Record<string, unknown>) => {
        const res = await h.cms(`${BASE}/import/preview`, { method: 'POST', cookie: owner, json: body })
        expect(res.status).toBe(400)
        return (await readJson<{ error: string }>(res)).error
      }
      expect(await problem(importBody('name\nAda'))).toContain('"email" column')
      expect(await problem(importBody('email\n"never closed'))).toContain('not valid CSV')
      expect(await problem(importBody('{', { format: 'json' }))).toContain('not valid JSON')
      expect(await problem(importBody('{"people":[]}', { format: 'json' }))).toContain('no list of members')
      const rows = ['email', ...Array.from({ length: MEMBER_IMPORT_MAX_ROWS + 1 }, (_, i) => `p${i}@example.com`)].join('\n')
      expect(await problem(importBody(rows))).toContain('split the file')
      expect(await problem(importBody(`email\n${'a'.repeat(5 * 1024 * 1024 + 1)}`))).toContain('5 MB')
      expect(await problem(importBody('email\na@example.com', { tags: ['instatic:owner'] }))).toContain('cannot be given')
    })
  })
})
