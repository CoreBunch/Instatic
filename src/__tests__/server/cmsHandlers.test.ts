import { afterEach, describe, expect, it } from 'bun:test'
import { handleCmsRequest } from '../../../server/handlers/cms'
import type { DbClient, DbResult } from '../../../server/db'
import { SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import { loginRateLimit } from '../../../server/auth/rateLimit'
import { configurePublicOrigins, resetPublicOrigins, stampSocketIp } from '../../../server/auth/security'

afterEach(() => {
  resetPublicOrigins()
})

function makeFakeDb() {
  const site: Record<string, unknown>[] = []
  const users: Record<string, unknown>[] = []
  const roles: Record<string, unknown>[] = [
    {
      id: 'owner',
      slug: 'owner',
      name: 'Owner',
      description: '',
      is_system: true,
      capabilities_json: [
        'site.read',
        'site.structure.edit',
        'site.content.edit',
        'site.style.edit',
        'pages.edit',
        'pages.publish',
        'content.create',
        'content.edit.own',
        'content.edit.any',
        'content.publish.own',
        'content.publish.any',
        'content.manage',
        'media.read',
        'media.write',
        'media.replace',
        'media.delete',
        'runtime.dependencies',
        'storage.elect',
        'storage.migrate',
        'plugins.read',
        'plugins.configure',
        'plugins.install',
        'plugins.lifecycle',
        'users.manage',
        'roles.manage',
        'audit.read',
      ],
    },
    {
      id: 'admin',
      slug: 'admin',
      name: 'Admin',
      description: '',
      is_system: true,
      capabilities_json: [
        'site.read',
        'site.structure.edit',
        'site.content.edit',
        'site.style.edit',
        'pages.edit',
        'pages.publish',
        'content.create',
        'content.edit.own',
        'content.edit.any',
        'content.publish.own',
        'content.publish.any',
        'content.manage',
        'media.read',
        'media.write',
        'media.replace',
        'media.delete',
        'runtime.dependencies',
        'storage.elect',
        'storage.migrate',
        'plugins.read',
        'plugins.configure',
        'plugins.install',
        'plugins.lifecycle',
        'users.manage',
        'roles.manage',
        'audit.read',
      ],
    },
    {
      id: 'member',
      slug: 'member',
      name: 'Member',
      description: '',
      is_system: true,
      capabilities_json: [],
    },
  ]
  const sessions: Record<string, unknown>[] = []
  const pages: Record<string, unknown>[] = []
  const auditEvents: Record<string, unknown>[] = []
  const loginAttempts: Record<string, unknown>[] = []

  function joinedUser(user: Record<string, unknown>) {
    const role = roles.find((candidate) => candidate.id === user.role_id) ?? roles[0]
    return {
      ...user,
      role_slug: role.slug,
      role_name: role.name,
      role_description: role.description,
      role_is_system: role.is_system,
      role_capabilities_json: role.capabilities_json,
    }
  }

  const handle = async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // Reconstruct a parameterized SQL string for pattern matching.
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // getSetupStatus — no values
    if (normalized.includes('count(*) as count from site')) {
      return { rows: [{ count: site.length } as Row], rowCount: 1 }
    }
    if (normalized.includes('count(*) as count') && normalized.includes('from users') && normalized.includes('role_id')) {
      const count = users.filter((user) =>
        user.role_id === 'owner' &&
        user.status === 'active' &&
        user.deleted_at == null
      ).length
      return { rows: [{ count } as Row], rowCount: 1 }
    }
    // createSite (repositories.ts) — values[0]=name, values[1]=settings
    // saveDraftSite (siteRepository.ts) — values[0]=name, values[1]=siteShell (via transaction)
    if (normalized.includes('insert into site')) {
      const row = { id: 'default', name: values[0], settings_json: values[1] }
      const index = site.findIndex((s) => s.id === 'default')
      if (index >= 0) site[index] = row
      else site.push(row)
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('insert into users')) {
      const row = {
        id: values[0],
        email: values[1],
        email_normalized: values[2],
        display_name: values[3],
        password_hash: values[4],
        status: values[5],
        role_id: values[6],
        last_login_at: null,
        failed_login_count: 0,
        locked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      }
      users.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    // recordFailedLoginAttempt — increments counter and sets locked_until.
    // Bind shape: values[0]=lockedUntil (Date|null), values[1]=userId.
    if (normalized.includes('update users') && normalized.includes('failed_login_count = failed_login_count + 1')) {
      const lockedUntil = values[0] as Date | null
      const userId = values[1]
      const user = users.find((candidate) => candidate.id === userId && candidate.deleted_at == null)
      if (!user) return { rows: [], rowCount: 0 }
      user.failed_login_count = Number(user.failed_login_count ?? 0) + 1
      user.locked_until = lockedUntil ? lockedUntil.toISOString() : null
      user.updated_at = new Date().toISOString()
      return {
        rows: [{ failed_login_count: user.failed_login_count, locked_until: user.locked_until } as Row],
        rowCount: 1,
      }
    }
    // recordLoginAttempt — append-only audit. Bind shape:
    // values[0]=id, values[1]=emailNorm, values[2]=ip, values[3]=userAgent,
    // values[4]=userId, values[5]=result.
    if (normalized.includes('insert into login_attempts')) {
      loginAttempts.push({
        id: values[0],
        email_norm: values[1],
        ip_address: values[2],
        user_agent: values[3],
        user_id: values[4],
        result: values[5],
        attempted_at: new Date().toISOString(),
      })
      return { rows: [], rowCount: 1 }
    }
    // setup.ts seeds the homepage via createDataRow (insert into data_rows)
    if (normalized.includes('insert into data_rows')) {
      const row = {
        id: values[0],
        table_id: values[1],
        cells_json: values[2],
        slug: values[3],
        status: values[4],
        author_user_id: values[5],
        created_by_user_id: values[6],
        updated_by_user_id: values[7],
      }
      const index = pages.findIndex((p) => p.id === row.id)
      if (index >= 0) pages[index] = row
      else pages.push(row)
      return { rows: [{ id: row.id } as Row], rowCount: 1 }
    }
    // listDataRows for pages — select from data_rows where table_id = 'pages'
    if (normalized.includes('from data_rows') && normalized.includes('left join users')) {
      return {
        rows: pages.map((p) => ({
          ...p,
          author_email: null,
          author_display_name: null,
          author_role_slug: null,
          author_role_name: null,
          creator_users: null,
          created_by_email: null,
          created_by_display_name: null,
          created_by_role_slug: null,
          created_by_role_name: null,
          updated_by_email: null,
          updated_by_display_name: null,
          updated_by_role_slug: null,
          updated_by_role_name: null,
          publisher_users: null,
          published_by_email: null,
          published_by_display_name: null,
          published_by_role_slug: null,
          published_by_role_name: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          published_at: null,
          deleted_at: null,
        })) as Row[],
        rowCount: pages.length,
      }
    }
    if (normalized.includes('from users') && normalized.includes('join roles') && normalized.includes('where users.email_normalized')) {
      const rows = users
        .filter((user) => String(user.email_normalized) === String(values[0]) && user.deleted_at == null)
        .map(joinedUser)
      return { rows: rows as Row[], rowCount: rows.length }
    }
    if (normalized.includes('from users') && normalized.includes('join roles') && normalized.includes('where users.id')) {
      const userId = values[0] ?? users[users.length - 1]?.id
      const rows = users
        .filter((user) => String(user.id) === String(userId) && user.deleted_at == null)
        .map(joinedUser)
      return { rows: rows as Row[], rowCount: rows.length }
    }
    if (normalized.includes('insert into sessions')) {
      const hasStepUpColumn = normalized.includes('step_up_expires_at')
      sessions.push({
        id_hash: values[0],
        user_id: values[1],
        expires_at: values[2],
        ip_address: values[3],
        user_agent: values[4],
        device_label: values[5] ?? '',
        mfa_passed_at: values[6] ?? null,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        revoked_at: null,
        step_up_expires_at: hasStepUpColumn ? values[7] ?? null : null,
      })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('select user_id') && normalized.includes('from sessions')) {
      const session = sessions.find((candidate) =>
        candidate.id_hash === values[0] && candidate.revoked_at == null,
      )
      return {
        rows: session ? [session as Row] : [],
        rowCount: session ? 1 : 0,
      }
    }
    // getSessionStepUpExpiresAt — `select step_up_expires_at from sessions
    // where id_hash = $1 and revoked_at is null`. Bind: values[0] = idHash.
    if (normalized.includes('select step_up_expires_at') && normalized.includes('from sessions')) {
      const session = sessions.find((candidate) =>
        candidate.id_hash === values[0] && candidate.revoked_at == null,
      )
      const row = session ? { step_up_expires_at: session.step_up_expires_at ?? null } : null
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }
    // markSessionStepUpFresh — `update sessions set step_up_expires_at = $1
    // where id_hash = $2 and revoked_at is null`. Bind: values[0] = expiresAt,
    // values[1] = idHash.
    if (normalized.includes('update sessions') && normalized.includes('step_up_expires_at')) {
      const session = sessions.find((candidate) =>
        candidate.id_hash === values[1] && candidate.revoked_at == null,
      )
      if (!session) return { rows: [], rowCount: 0 }
      session.step_up_expires_at = values[0] instanceof Date
        ? values[0].toISOString()
        : (values[0] as string | null)
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('from sessions') && normalized.includes('join users')) {
      const session = sessions.find((candidate) => candidate.id_hash === values[0] && candidate.revoked_at == null)
      const user = session ? users.find((candidate) => candidate.id === session.user_id && candidate.status === 'active') : null
      const rows = user ? [{
        ...joinedUser(user),
        session_mfa_passed_at: session.mfa_passed_at ?? null,
        avatar_public_path: null,
      }] : []
      return { rows: rows as Row[], rowCount: rows.length }
    }
    if (normalized.includes('update sessions') && normalized.includes('last_seen_at')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('update sessions') && normalized.includes('revoked_at')) {
      const now = new Date().toISOString()
      if (normalized.includes('where user_id = $1') && normalized.includes('id_hash != $2')) {
        let count = 0
        for (const session of sessions) {
          if (session.user_id === values[0] && session.id_hash !== values[1] && session.revoked_at == null) {
            session.revoked_at = now
            count += 1
          }
        }
        return { rows: [], rowCount: count }
      }
      if (normalized.includes('where user_id = $1')) {
        let count = 0
        for (const session of sessions) {
          if (session.user_id === values[0] && session.revoked_at == null) {
            session.revoked_at = now
            count += 1
          }
        }
        return { rows: [], rowCount: count }
      }
      const session = sessions.find((candidate) => candidate.id_hash === values[0])
      if (session) session.revoked_at = now
      return { rows: [], rowCount: session ? 1 : 0 }
    }
    // The full updateUser path (`set email, ..., role_id, updated_at`) must
    // be matched BEFORE the `last_login_at` matcher because the RETURNING
    // clause of this SQL also mentions `last_login_at`.
    if (normalized.includes('update users') && normalized.includes('set email =')) {
      const userId = values[7]
      const user = users.find((candidate) => candidate.id === userId && candidate.deleted_at == null)
      if (!user) return { rows: [], rowCount: 0 }
      Object.assign(user, {
        email: values[0],
        email_normalized: values[1],
        display_name: values[2],
        password_hash: values[3],
        password_updated_at: values[4],
        status: values[5],
        role_id: values[6],
        updated_at: new Date().toISOString(),
      })
      return { rows: [user as Row], rowCount: 1 }
    }
    if (normalized.includes('update users') && normalized.includes('set deleted_at')) {
      const user = users.find((candidate) => candidate.id === values[0] && candidate.deleted_at == null)
      if (!user) return { rows: [], rowCount: 0 }
      user.deleted_at = new Date().toISOString()
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('update users') && normalized.includes('last_login_at')) {
      // Bind shape now: values[0]=null (for locked_until clear), values[1]=userId.
      // Match by trying each value as a candidate user id; production code passes
      // userId last but tests should not depend on which slot it occupies.
      const user = users.find((candidate) =>
        values.some((v) => v === candidate.id),
      )
      if (user) {
        user.last_login_at = new Date().toISOString()
        user.failed_login_count = 0
        user.locked_until = null
      }
      return { rows: [], rowCount: user ? 1 : 0 }
    }
    if (normalized.includes('insert into audit_events')) {
      auditEvents.push({
        id: values[0],
        actor_user_id: values[1],
        action: values[2],
        target_type: values[3],
        target_id: values[4],
        metadata_json: values[5],
        ip_address: values[6],
        user_agent: values[7],
      })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  // Repositories that splice shared column lists (users + sessions) issue their
  // SELECTs through db.unsafe(rawSql, params). Re-dispatch those through the
  // same tagged-template matcher by splitting the raw SQL on its positional
  // placeholders ($1.. or ?) so `values` lines up with `params`.
  handle.unsafe = async <Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbResult<Row>> =>
    handle<Row>(sql.split(/\$\d+|\?/) as unknown as TemplateStringsArray, ...params)

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return Object.assign(handle as DbClient, { site, users, roles, sessions, pages, auditEvents, loginAttempts })
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

async function stepUpCookie(
  db: DbClient,
  cookie: string,
  password = 'long-enough-password',
): Promise<string> {
  const req = new Request('http://localhost/admin/api/cms/auth/step-up', {
    method: 'POST',
    body: JSON.stringify({ password }),
    headers: { 'content-type': 'application/json' },
  })
  req.headers.set('cookie', cookie)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  const steppedCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  expect(steppedCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return steppedCookie
}

describe('CMS handlers', () => {
  it('reports setup status', async () => {
    const db = makeFakeDb()
    const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup/status'), db)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ hasSite: false, hasAdmin: false, hasOwner: false, needsSetup: true })
  })

  it('creates the first site and owner account', async () => {
    // Step 2 of unified-content-storage: the legacy pages table is gone; the
    // home page seed will be added back in Step 3 as a data_row in the
    // seeded 'pages' data table. For now setup creates the site + owner only.
    const db = makeFakeDb()
    const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ ok: true })
    expect(db.site).toHaveLength(1)
    expect(db.users).toHaveLength(1)
    expect(db.users[0]).toMatchObject({ email_normalized: 'owner@example.com', role_id: 'owner', status: 'active' })
    expect(db.auditEvents[0]?.ip_address).toBeNull()
  })

  it('refuses setup after an owner exists', async () => {
    const db = makeFakeDb()
    db.site.push({ id: 'default', name: 'Existing' })
    db.users.push({
      id: 'owner_1',
      email: 'owner@example.com',
      email_normalized: 'owner@example.com',
      display_name: 'Owner',
      password_hash: 'hash',
      status: 'active',
      role_id: 'owner',
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    })
    const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'new@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(res.status).toBe(409)
  })

  it('logs in and sets an HttpOnly session cookie', async () => {
    const db = makeFakeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const loginReq = new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    })
    stampSocketIp(loginReq, '203.0.113.77')
    const res = await handleCmsRequest(loginReq, db)
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cookie).toContain('Path=/admin')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    // Plain HTTP request → cookie must NOT carry the Secure flag, otherwise
    // browsers reject it.
    expect(cookie).not.toContain('Secure')
    expect(db.sessions).toHaveLength(1)
    expect(db.sessions[0]?.ip_address).toBe('203.0.113.77')
    expect(db.auditEvents.at(-1)?.ip_address).toBe('203.0.113.77')
  })

  it('returns the current user with role capabilities', async () => {
    const db = makeFakeDb()
    const email = 'me-owner@example.com'
    loginRateLimit.reset(`unknown|${email}`)
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email, password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const loginRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(loginRes.status).toBe(200)
    const cookie = await stepUpCookie(db, (loginRes.headers.get('set-cookie') ?? '').split(';')[0])

    const meReq = new Request('http://localhost/admin/api/cms/me', {
      method: 'GET',
    })
    meReq.headers.set('cookie', cookie)
    const me = await handleCmsRequest(meReq, db)

    expect(me.status).toBe(200)
    expect(await json(me)).toMatchObject({
      user: {
        email,
        role: { slug: 'owner' },
        capabilities: expect.arrayContaining(['users.manage', 'roles.manage']),
      },
    })
    loginRateLimit.reset(`unknown|${email}`)
  })

  it('keeps owner setup-only when managing users', async () => {
    const db = makeFakeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner-only@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const loginRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner-only@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const cookie = await stepUpCookie(db, (loginRes.headers.get('set-cookie') ?? '').split(';')[0])
    const createReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'second-owner@example.com',
        displayName: 'Second Owner',
        password: 'another-long-password',
        roleId: 'owner',
      }),
      headers: { 'content-type': 'application/json' },
    })
    createReq.headers.set('cookie', cookie)

    const createRes = await handleCmsRequest(createReq, db)

    expect(createRes.status).toBe(400)
    expect(await json(createRes)).toEqual({ error: 'Owner role is setup-only' })
    expect(db.users.filter((user) => user.role_id === 'owner')).toHaveLength(1)
  })

  it('prevents assigning the owner role after setup and prevents owner self-demotion', async () => {
    const db = makeFakeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner-role@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const loginRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner-role@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const cookie = await stepUpCookie(db, (loginRes.headers.get('set-cookie') ?? '').split(';')[0])

    const createReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin-target@example.com',
        displayName: 'Admin Target',
        password: 'another-long-password',
        roleId: 'admin',
      }),
      headers: { 'content-type': 'application/json' },
    })
    createReq.headers.set('cookie', cookie)
    const createRes = await handleCmsRequest(createReq, db)
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { user: { id: string } }

    const assignOwnerReq = new Request(`http://localhost/admin/api/cms/users/${created.user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ roleId: 'owner' }),
      headers: { 'content-type': 'application/json' },
    })
    assignOwnerReq.headers.set('cookie', cookie)
    const assignOwnerRes = await handleCmsRequest(assignOwnerReq, db)
    expect(assignOwnerRes.status).toBe(400)
    expect(await json(assignOwnerRes)).toEqual({ error: 'Owner role is setup-only' })

    const ownerId = String(db.users.find((user) => user.role_id === 'owner')?.id)
    const selfDemoteReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ roleId: 'admin' }),
      headers: { 'content-type': 'application/json' },
    })
    selfDemoteReq.headers.set('cookie', cookie)
    const selfDemoteRes = await handleCmsRequest(selfDemoteReq, db)
    expect(selfDemoteRes.status).toBe(409)
    expect(await json(selfDemoteRes)).toEqual({ error: 'Owner cannot change their own role' })
  })

  it('prevents a non-owner admin from mutating the Owner row (password / email / delete)', async () => {
    // Regression test for F-0001: any actor with `users.manage` (admin role)
    // must NOT be able to PATCH the Owner row's password (Owner-takeover
    // primitive) or DELETE it. Only the Owner themself may mutate the Owner
    // row.
    const db = makeFakeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'real-owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const ownerLogin = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'real-owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const ownerCookie = await stepUpCookie(db, (ownerLogin.headers.get('set-cookie') ?? '').split(';')[0])

    // Owner creates an admin co-worker.
    const createAdminReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'rogue-admin@example.com',
        displayName: 'Rogue Admin',
        password: 'rogue-admin-password',
        roleId: 'admin',
      }),
      headers: { 'content-type': 'application/json' },
    })
    createAdminReq.headers.set('cookie', ownerCookie)
    const createAdminRes = await handleCmsRequest(createAdminReq, db)
    expect(createAdminRes.status).toBe(201)

    const adminLogin = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'rogue-admin@example.com', password: 'rogue-admin-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const adminCookie = await stepUpCookie(
      db,
      (adminLogin.headers.get('set-cookie') ?? '').split(';')[0],
      'rogue-admin-password',
    )

    const ownerId = String(db.users.find((user) => user.role_id === 'owner')?.id)
    const ownerHashBefore = db.users.find((user) => user.role_id === 'owner')?.password_hash

    // Admin tries to overwrite the Owner's password — must be rejected with 403.
    const passwordPatchReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: 'attacker-chosen-password' }),
      headers: { 'content-type': 'application/json' },
    })
    passwordPatchReq.headers.set('cookie', adminCookie)
    const passwordPatchRes = await handleCmsRequest(passwordPatchReq, db)
    expect(passwordPatchRes.status).toBe(403)
    expect(await json(passwordPatchRes)).toEqual({ error: 'Only the owner can modify the owner account' })

    // Owner's password_hash must not have been touched.
    expect(db.users.find((user) => user.role_id === 'owner')?.password_hash).toBe(ownerHashBefore)

    // Admin tries to rewrite the Owner's email — also rejected.
    const emailPatchReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ email: 'hijacked@example.com' }),
      headers: { 'content-type': 'application/json' },
    })
    emailPatchReq.headers.set('cookie', adminCookie)
    const emailPatchRes = await handleCmsRequest(emailPatchReq, db)
    expect(emailPatchRes.status).toBe(403)
    expect(db.users.find((user) => user.role_id === 'owner')?.email).toBe('real-owner@example.com')

    // Admin tries to delete the Owner — rejected with 403, NOT the
    // "last active owner" 409 (we want the row-level guard to fire first
    // so the surface stays closed even if multi-owner is added later).
    const deleteReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'DELETE',
    })
    deleteReq.headers.set('cookie', adminCookie)
    const deleteRes = await handleCmsRequest(deleteReq, db)
    expect(deleteRes.status).toBe(403)
    expect(await json(deleteRes)).toEqual({ error: 'Only the owner can delete the owner account' })
    expect(db.users.find((user) => user.role_id === 'owner')?.deleted_at).toBeNull()

    // The Owner themself may still update their own row (e.g. rotate
    // password) — sanity check we didn't over-rotate.
    const selfPatchReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: 'owner-rotated-password' }),
      headers: { 'content-type': 'application/json' },
    })
    selfPatchReq.headers.set('cookie', ownerCookie)
    const selfPatchRes = await handleCmsRequest(selfPatchReq, db)
    expect(selfPatchRes.status).toBe(200)
  })

  // ─── Secure cookie flag ─────────────────────────────────────────────────
  // Managed HTTPS platforms (and Caddy in compose.tls.yml) terminate TLS at the
  // edge and hand the container plain HTTP. The handler sets `Secure` from the
  // configured public origin's scheme — never from an untrusted
  // X-Forwarded-Proto header — so the cookie is reliably Secure on HTTPS
  // platforms. Direct HTTP requests with no https public origin must NOT get a
  // Secure cookie (which browsers would reject).
  describe('session cookie Secure flag', () => {
    async function loginThen(): Promise<string> {
      const db = makeFakeDb()
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'Example', email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      expect(res.status).toBe(200)
      return res.headers.get('set-cookie') ?? ''
    }

    it('sets Secure when an https public origin is configured (TLS terminated at the edge, req.url is http)', async () => {
      configurePublicOrigins(['https://cms.example.com'])
      const cookie = await loginThen()
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
    })

    it('does NOT set Secure when the configured public origin is http', async () => {
      configurePublicOrigins(['http://cms.example.com'])
      const cookie = await loginThen()
      expect(cookie).not.toContain('Secure')
    })

    it('does NOT set Secure when no public origin is configured and the request is HTTP', async () => {
      const cookie = await loginThen()
      expect(cookie).not.toContain('Secure')
    })

    it('ignores a spoofed X-Forwarded-Proto: https when no https public origin is configured', async () => {
      const db = makeFakeDb()
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'Example', email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      }), db)
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie') ?? '').not.toContain('Secure')
    })

    it('logout cookie also gets Secure when an https public origin is configured', async () => {
      configurePublicOrigins(['https://cms.example.com'])
      const db = makeFakeDb()
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'Example', email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const loginRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const sessionCookie = (loginRes.headers.get('set-cookie') ?? '')
        .split(';')[0] // just `instatic_admin_session=<token>`

      const logoutRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/logout', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: sessionCookie,
        },
      }), db)
      expect(logoutRes.status).toBe(200)
      const cookie = logoutRes.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('Max-Age=0')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
    })
  })

  // ─── Login rate limiting + constant-time + origin check ────────────────
  describe('login security', () => {
    /**
     * Make a login attempt with a unique XFF so the rate limit bucket key
     * doesn't bleed across tests.
     *
     * `Origin` is set on the constructed Headers post-hoc because happy-dom
     * (loaded via the test setup) strictly follows the Fetch spec's
     * "forbidden request headers" rule: passing `origin` in the Request
     * constructor's `headers` init silently drops it. In production, Bun.serve
     * receives the raw HTTP Origin header from the wire — no such filtering
     * applies. Mutating headers after Request construction works in both
     * environments, so we use that path here.
     */
    function loginRequest(email: string, password: string, ip: string, origin?: string): Request {
      const req = new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        headers: { 'content-type': 'application/json' },
      })
      stampSocketIp(req, ip)
      if (origin) req.headers.set('origin', origin)
      return req
    }

    async function makeDbWithAdmin() {
      const db = makeFakeDb()
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'X', email: 'owner@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      return db
    }

    it('rate-limits to 5 attempts per (IP, email), then returns 429 with Retry-After', async () => {
      // Use a unique IP+email so the singleton bucket starts fresh.
      const xff = '203.0.113.10'
      const email = 'rate-limit-test@example.com'
      loginRateLimit.reset(`${xff}|${email}`)

      const db = await makeDbWithAdmin()

      for (let i = 0; i < 5; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      const blocked = await handleCmsRequest(
        loginRequest(email, 'wrong-password', xff),
        db,
      )
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBeTruthy()
      const body = await blocked.json() as { error: string }
      expect(body.error).toMatch(/too many/i)

      // Cleanup so the bucket doesn't leak into other tests.
      loginRateLimit.reset(`${xff}|${email}`)
    })

    it('clears the bucket on successful login (forgotten password recovery flow)', async () => {
      const xff = '203.0.113.20'
      const email = 'owner@example.com'
      loginRateLimit.reset(`${xff}|${email}`)

      const db = await makeDbWithAdmin()

      // Three failed attempts.
      for (let i = 0; i < 3; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      // Successful login resets BOTH the rate-limit bucket and the
      // per-account failed-login counter (markUserLoggedIn sets the column to
      // 0 and clears locked_until).
      const ok = await handleCmsRequest(
        loginRequest(email, 'long-enough-password', xff),
        db,
      )
      expect(ok.status).toBe(200)

      // Now four more wrong attempts must still be allowed (rate-limit
      // bucket was cleared, lockout counter was zeroed). The 5th wrong
      // attempt would trigger the per-account lockout — that's a separate
      // concern covered by authLockoutLogin.test.ts.
      for (let i = 0; i < 4; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      loginRateLimit.reset(`${xff}|${email}`)
    })

    it('returns 401 (not 404) for an unknown email — same response shape as wrong-password', async () => {
      const xff = '203.0.113.30'
      const unknownEmail = 'does-not-exist@example.com'
      loginRateLimit.reset(`${xff}|${unknownEmail}`)
      loginRateLimit.reset(`${xff}|owner@example.com`)

      const db = await makeDbWithAdmin()

      // Unknown email (constant-time path runs argon2id verify against a dummy hash).
      const res = await handleCmsRequest(
        loginRequest(unknownEmail, 'long-enough-password', xff),
        db,
      )
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Invalid email or password')

      // Wrong password for an existing email should produce the EXACT same
      // response shape — no enumeration via different error messages.
      const res2 = await handleCmsRequest(
        loginRequest('owner@example.com', 'wrong-password', xff),
        db,
      )
      expect(res2.status).toBe(401)
      const body2 = await res2.json() as { error: string }
      expect(body2.error).toBe('Invalid email or password')

      loginRateLimit.reset(`${xff}|${unknownEmail}`)
      loginRateLimit.reset(`${xff}|owner@example.com`)
    })

    it('rejects state-changing requests with a foreign Origin (CSRF defense)', async () => {
      const db = await makeDbWithAdmin()
      const probe = loginRequest('owner@example.com', 'long-enough-password', '203.0.113.99', 'https://evil.example.com')
      // Sanity-assert that the test fixture builds the request we expect.
      expect(probe.headers.get('origin')).toBe('https://evil.example.com')
      expect(probe.method).toBe('POST')
      const res = await handleCmsRequest(probe, db)
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/origin/i)
    })

    it('accepts state-changing requests with no Origin (curl, server-to-server)', async () => {
      const db = await makeDbWithAdmin()
      // No `origin` header — must be allowed (covers curl/CLI/server-to-server).
      loginRateLimit.reset('203.0.113.40|owner@example.com')
      const res = await handleCmsRequest(
        loginRequest('owner@example.com', 'long-enough-password', '203.0.113.40'),
        db,
      )
      expect(res.status).toBe(200)
      loginRateLimit.reset('203.0.113.40|owner@example.com')
    })
  })
})
