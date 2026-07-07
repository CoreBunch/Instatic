import { describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/auth/tokens'
import type { DbClient, DbResult } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'

function makeFakeDb() {
  let siteRow: Record<string, unknown> | null = null
  const admins: Record<string, unknown>[] = [
    {
      id: 'admin_1',
      email: 'owner@example.com',
      password_hash: 'hash',
      created_at: new Date('2026-01-01').toISOString(),
    },
  ]
  const sessions: Record<string, unknown>[] = []

  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // Reconstruct a parameterized SQL string for pattern matching.
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('from sessions') && normalized.includes('join users')) {
      const session = sessions.find((s) => String(s.id_hash) === String(values[0]))
      if (!session) return { rows: [], rowCount: 0 }
      const admin = admins.find((a) => a.id === session.user_id)
      return {
        rows: admin ? [{
          ...admin,
          email_normalized: admin.email,
          display_name: 'Owner',
          status: 'active',
          role_id: 'owner',
          last_login_at: null,
          updated_at: admin.created_at,
          deleted_at: null,
          role_slug: 'owner',
          role_name: 'Owner',
          role_description: '',
          role_is_system: true,
          role_capabilities_json: ['site.read', 'site.structure.edit','site.content.edit','site.style.edit', 'pages.edit'],
          session_mfa_passed_at: null,
          avatar_public_path: null,
        } as Row] : [],
        rowCount: admin ? 1 : 0,
      }
    }
    if (normalized.includes('update sessions') && normalized.includes('last_seen_at')) {
      return { rows: [], rowCount: 1 }
    }
    // saveDraftSite — insert into site
    if (normalized.includes('insert into site')) {
      siteRow = {
        id: 'default',
        name: values[0],
        settings_json: values[1],
        created_at: new Date('2026-01-01').toISOString(),
        updated_at: new Date('2026-01-02').toISOString(),
      }
      return { rows: [], rowCount: 1 }
    }
    // getDraftSite: select site
    if (normalized.includes('select id, name, settings_json')) {
      return { rows: siteRow ? [siteRow as Row] : [], rowCount: siteRow ? 1 : 0 }
    }
    // allocateSiteSeq — the site-document save's sync counter
    if (normalized.includes('update site_sync_state')) {
      return { rows: [{ seq: 1 } as unknown as Row], rowCount: 1 }
    }
    // stampDraftSiteSeq
    if (normalized.includes('update site set seq')) {
      return { rows: [], rowCount: 1 }
    }
    // listDataRows / listDataRowIdSlugs / listSoftDeletedDataRowIds — this
    // fake stores no rows; the save round-trip ships empty change sets.
    if (normalized.includes('from data_rows')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  handle.unsafe = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<DbResult<Row>> => {
    const fakeStrings = [sql] as unknown as TemplateStringsArray
    return handle<Row>(fakeStrings, ...(params ?? []))
  }

  return Object.assign(handle as DbClient, {
    get site() { return siteRow },
    admins,
    sessions,
  })
}

function shell(): SiteShell {
  return {
    id: 'project_1',
    name: 'CMS Site',
    files: [],
    visualComponents: [],
    breakpoints: [
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ],
    settings: {
      shortcuts: {},
    },
    styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {} },
    createdAt: 1000,
    updatedAt: 2000,
  }
}

async function createCookie(db: ReturnType<typeof makeFakeDb>): Promise<string> {
  const token = 'valid-session-token'
  db.sessions.push({
    id_hash: await hashSessionToken(token),
    user_id: 'admin_1',
    expires_at: new Date('2030-01-01').toISOString(),
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

function cmsRequest(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    url,
    method: init.method ?? 'GET',
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null
      },
    },
    async json() {
      return init.body ? JSON.parse(init.body) : {}
    },
  } as Request
}

describe('cms site handlers', () => {
  it('requires an admin session for draft site reads', async () => {
    const db = makeFakeDb()
    const res = await handleCmsRequest(cmsRequest('http://localhost/admin/api/cms/site'), db)

    expect(res.status).toBe(401)
  })

  it('saves and loads the draft site shell for an authenticated admin', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    const save = await handleCmsRequest(cmsRequest('http://localhost/admin/api/cms/site-document', {
      method: 'PUT',
      body: JSON.stringify({
        mode: 'incremental',
        site: shell(),
        changedPages: [],
        deletedPageIds: [],
        changedComponents: [],
        deletedComponentIds: [],
        changedLayouts: [],
        deletedLayoutIds: [],
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
      },
    }), db)
    expect(save.status).toBe(200)

    const load = await handleCmsRequest(cmsRequest('http://localhost/admin/api/cms/site', {
      headers: { cookie },
    }), db)
    expect(load.status).toBe(200)
    // The site endpoint returns the shell (without pages — pages are in data_rows)
    const body = await load.json() as { site: Record<string, unknown> }
    expect(body.site).toMatchObject({
      id: 'project_1',
      name: 'CMS Site',
    })
    // No pages field in the shell response
    expect(body.site.pages).toBeUndefined()
  })
})
