import { afterEach, describe, expect, it } from 'bun:test'
import type { DbResult } from '../../../server/db'
import { handlePublicFormRequest } from '../../../server/forms/handler'
import {
  issuePublicFormChallenge,
  issuePublicFormPageToken,
  resetPublicFormChallenges,
  verifyAndConsumePublicFormChallenge,
} from '../../../server/forms/challenge'
import { publicFormPerFormRateLimit, publicFormPerIpRateLimit } from '../../../server/forms/rateLimit'
import { configurePublicOrigins, resetPublicOrigins, stampSocketIp } from '../../../server/auth/security'
import { createFakeDb } from './dbTestFake'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'

function makeRequest(
  path: string,
  body: unknown,
  origin = 'http://cms.test',
  ip?: string,
) {
  const req = new Request(`http://cms.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  req.headers.set('origin', origin)
  req.headers.set('sec-fetch-site', 'same-origin')
  if (ip) stampSocketIp(req, ip)
  return req
}

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []) {
  return {
    id,
    moduleId,
    props,
    children,
    breakpointOverrides: {},
    classIds: [],
  }
}

function makeSnapshot(targetTableId = 'newsletter_submissions'): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId: 'page-home',
    site: {
      id: 'site',
      name: 'Site',
      settings: {},
      pages: [{
        id: 'page-home',
        slug: 'index',
        title: 'Home',
        rootNodeId: 'body',
        nodes: {
          body: node('body', 'base.body', {}, ['form']),
          form: node('form', 'base.form', {
            mode: 'cms',
            formId: 'newsletter',
            targetTableId,
            honeypotName: 'company',
            minSubmitSeconds: 0,
          }, ['input']),
          input: node('input', 'base.input', {
            fieldId: 'email',
            name: 'email',
            id: 'email-input',
            inputType: 'email',
            required: true,
          }),
        },
      }],
      visualComponents: [],
      classes: [],
      breakpoints: [],
      settingsVersion: 1,
    },
  } as PublishedPageSnapshot
}

interface FakeTableRow {
  id: string
  name: string
  slug: string
  kind: string
  route_base: string
  singular_label: string
  plural_label: string
  primary_field_id: string
  fields_json: unknown[]
  system: number
}

const newsletterTableRow: FakeTableRow = {
  id: 'newsletter_submissions',
  name: 'Newsletter submissions',
  slug: 'newsletter-submissions',
  kind: 'data',
  route_base: '',
  singular_label: 'Submission',
  plural_label: 'Submissions',
  primary_field_id: 'email',
  fields_json: [{ id: 'email', label: 'Email', type: 'email', required: true }],
  system: 0,
}

function makeDb(options: {
  snapshot?: PublishedPageSnapshot
  tableRows?: Record<string, FakeTableRow>
} = {}) {
  const createdRows: Record<string, unknown>[] = []
  const snapshot = options.snapshot ?? makeSnapshot()
  const tableRows = options.tableRows ?? { newsletter_submissions: newsletterTableRow }
  const db = createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()
    // getPublishedPageSnapshotById — joins data_row_versions to site_snapshots.
    // Must be matched before the generic `select data_rows.id` branch below
    // (the snapshot getter's SELECT also starts with `select data_rows.id`).
    if (sql.includes('site_snapshots.site_json')) {
      return {
        rows: [{
          row_id: snapshot.pageRowId,
          site_json: snapshot.site,
          runtime_assets_json: snapshot.runtimeAssets ?? null,
          importmap_body: snapshot.runtimePackageImportmap?.body ?? null,
          importmap_sha256: snapshot.runtimePackageImportmap?.sha256 ?? null,
        }],
        rowCount: 1,
      }
    }
    if (sql.startsWith('select id, name, slug, kind, route_base')) {
      const row = tableRows[String(params[0])]
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          ...row,
          created_by_user_id: null,
          updated_by_user_id: null,
          created_at: new Date('2026-06-01T00:00:00Z'),
          updated_at: new Date('2026-06-01T00:00:00Z'),
        }],
        rowCount: 1,
      }
    }
    if (sql.startsWith('insert into data_rows')) {
      createdRows.push({
        id: params[0],
        table_id: params[1],
        cells_json: params[2],
        slug: params[3],
        status: params[4],
        author_user_id: params[5],
        created_by_user_id: params[6],
        updated_by_user_id: params[7],
      })
      return { rows: [{ id: params[0] }], rowCount: 1 }
    }
    if (sql.startsWith('select data_rows.id') && sql.includes('from data_rows')) {
      const row = createdRows.find((candidate) => candidate.id === params[0])
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          ...row,
          author_email: null,
          author_display_name: null,
          author_role_slug: null,
          author_role_name: null,
          created_by_email: null,
          created_by_display_name: null,
          created_by_role_slug: null,
          created_by_role_name: null,
          updated_by_email: null,
          updated_by_display_name: null,
          updated_by_role_slug: null,
          updated_by_role_name: null,
          published_by_email: null,
          published_by_display_name: null,
          published_by_role_slug: null,
          published_by_role_name: null,
          published_at: null,
          scheduled_publish_at: null,
          deleted_at: null,
          created_at: new Date('2026-06-01T00:00:00Z'),
          updated_at: new Date('2026-06-01T00:00:00Z'),
        }],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })
  return { db, createdRows }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

function pageToken(): string {
  return issuePublicFormPageToken({ pageId: 'page-home', formId: 'newsletter' })
}

describe('public CMS-native form endpoint', () => {
  afterEach(() => {
    resetPublicOrigins()
  })

  it('rejects challenge requests from foreign origins', async () => {
    const { db } = makeDb()
    const response = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', { formId: 'newsletter', pageId: 'page-home', pageToken: pageToken() }, 'https://evil.test'),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )

    expect(response?.status).toBe(403)
  })

  it('accepts a challenge whose Origin matches a non-canonical configured public origin (allowlist regression)', async () => {
    resetPublicFormChallenges()
    // The canonical origin is the Railway platform domain; the visitor reaches
    // the site via the second (custom-domain) entry. The forms CSRF check must
    // honour the FULL configured allowlist, not just the first/canonical entry
    // — the old inline duplicate only compared against expectedOrigin() and
    // would have rejected this.
    configurePublicOrigins(['https://app.up.railway.app', 'https://forms.example.com'])
    const { db } = makeDb()
    const response = await handlePublicFormRequest(
      makeRequest(
        '/_instatic/form/challenge',
        { formId: 'newsletter', pageId: 'page-home', pageToken: pageToken() },
        'https://forms.example.com',
      ),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )

    expect(response?.status).toBe(200)
  })

  it('issues a same-origin challenge and rejects submits without it', async () => {
    resetPublicFormChallenges()
    const { db } = makeDb()
    const challenge = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', { formId: 'newsletter', pageId: 'page-home', pageToken: pageToken() }),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )
    expect(challenge?.status).toBe(200)
    const challengeBody = await readJson(challenge!)
    expect(typeof challengeBody.token).toBe('string')
    expect(typeof challengeBody.challenge).toBe('string')

    const submit = await handlePublicFormRequest(
      makeRequest('/_instatic/form/submit', {
        formId: 'newsletter',
        pageId: 'page-home',
        token: 'missing',
        challenge: 'missing',
        values: { email: 'ai@example.com' },
      }),
      db,
      new URL('http://cms.test/_instatic/form/submit'),
    )
    expect(submit?.status).toBe(400)
  })

  it('rejects challenge requests without the published page token', async () => {
    resetPublicFormChallenges()
    const { db } = makeDb()
    const response = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', {
        formId: 'newsletter',
        pageId: 'page-home',
        pageToken: 'forged',
      }),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )

    expect(response?.status).toBe(403)
  })

  it('rejects oversized challenge payloads before accepting the request', async () => {
    resetPublicFormChallenges()
    const { db } = makeDb()
    const response = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', {
        formId: 'newsletter',
        pageId: 'page-home',
        pageToken: pageToken(),
        padding: 'x'.repeat(9 * 1024),
      }, 'http://cms.test', '203.0.113.20'),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )

    expect(response?.status).toBe(413)
  })

  it('rate-limits challenge issuance per client', async () => {
    resetPublicFormChallenges()
    const { db } = makeDb()
    const ip = '203.0.113.21'
    for (let i = 0; i < 60; i++) {
      const response = await handlePublicFormRequest(
        makeRequest('/_instatic/form/challenge', {
          formId: 'newsletter',
          pageId: 'page-home',
          pageToken: pageToken(),
        }, 'http://cms.test', ip),
        db,
        new URL('http://cms.test/_instatic/form/challenge'),
      )
      expect(response?.status).toBe(200)
    }

    const limited = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', {
        formId: 'newsletter',
        pageId: 'page-home',
        pageToken: pageToken(),
      }, 'http://cms.test', ip),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )
    expect(limited?.status).toBe(429)
  })

  it('keeps the in-memory challenge store bounded by evicting oldest entries', () => {
    resetPublicFormChallenges()
    const first = issuePublicFormChallenge({ pageId: 'page-home', formId: 'newsletter' })
    for (let i = 0; i < 2_000; i++) {
      issuePublicFormChallenge({ pageId: 'page-home', formId: `newsletter-${i}` })
    }

    expect(verifyAndConsumePublicFormChallenge({
      pageId: 'page-home',
      formId: 'newsletter',
      challenge: first.challenge,
      token: first.token,
    })).toBeNull()
  })

  it('creates a data row for a valid challenged submission', async () => {
    resetPublicFormChallenges()
    publicFormPerIpRateLimit.reset('unknown')
    publicFormPerFormRateLimit.reset('unknown|newsletter')
    const { db, createdRows } = makeDb()
    const challengeResponse = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', { formId: 'newsletter', pageId: 'page-home', pageToken: pageToken() }),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )
    const challenge = await readJson(challengeResponse!)

    const submit = await handlePublicFormRequest(
      makeRequest('/_instatic/form/submit', {
        formId: 'newsletter',
        pageId: 'page-home',
        token: challenge.token,
        challenge: challenge.challenge,
        values: { email: 'ai@example.com', company: '' },
      }),
      db,
      new URL('http://cms.test/_instatic/form/submit'),
    )

    expect(submit?.status).toBe(200)
    expect(createdRows).toHaveLength(1)
    expect(createdRows[0].table_id).toBe('newsletter_submissions')
    expect(createdRows[0].cells_json).toEqual({ email: 'ai@example.com' })
  })

  it('rejects oversized submit payloads before consuming form rate-limit quota', async () => {
    resetPublicFormChallenges()
    publicFormPerIpRateLimit.reset('203.0.113.22')
    publicFormPerFormRateLimit.reset('203.0.113.22|newsletter')
    const { db } = makeDb()

    const response = await handlePublicFormRequest(
      makeRequest('/_instatic/form/submit', {
        formId: 'newsletter',
        pageId: 'page-home',
        token: 'missing',
        challenge: 'missing',
        values: { email: `${'a'.repeat(1024 * 1024)}@example.com` },
      }, 'http://cms.test', '203.0.113.22'),
      db,
      new URL('http://cms.test/_instatic/form/submit'),
    )

    expect(response?.status).toBe(413)

    const allowedAfterOversize = publicFormPerIpRateLimit.consume('203.0.113.22')
    expect(allowedAfterOversize.remaining).toBe(59)
    publicFormPerIpRateLimit.reset('203.0.113.22')
  })

  it('rejects system data tables as public form targets', async () => {
    resetPublicFormChallenges()
    publicFormPerIpRateLimit.reset('unknown')
    publicFormPerFormRateLimit.reset('unknown|newsletter')
    const { db, createdRows } = makeDb({
      snapshot: makeSnapshot('system_submissions'),
      tableRows: {
        system_submissions: {
          ...newsletterTableRow,
          id: 'system_submissions',
          name: 'System submissions',
          slug: 'system-submissions',
          system: 1,
        },
      },
    })
    const challengeResponse = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', { formId: 'newsletter', pageId: 'page-home', pageToken: pageToken() }),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )
    const challenge = await readJson(challengeResponse!)

    const submit = await handlePublicFormRequest(
      makeRequest('/_instatic/form/submit', {
        formId: 'newsletter',
        pageId: 'page-home',
        token: challenge.token,
        challenge: challenge.challenge,
        values: { email: 'ai@example.com', company: '' },
      }),
      db,
      new URL('http://cms.test/_instatic/form/submit'),
    )

    expect(submit?.status).toBe(404)
    expect(createdRows).toHaveLength(0)
  })
})
