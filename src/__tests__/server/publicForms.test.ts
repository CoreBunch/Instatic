import { afterEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import { handlePublicFormRequest } from '../../../server/forms/handler'
import { handleServerRequest } from '../../../server/router'
import {
  issuePublicFormChallenge,
  issuePublicFormPageToken,
  resetPublicFormChallenges,
  verifyAndConsumePublicFormChallenge,
} from '../../../server/forms/challenge'
import { publicFormPerFormRateLimit, publicFormPerIpRateLimit } from '../../../server/forms/rateLimit'
import { configurePublicOrigins, resetPublicOrigins, stampSocketIp } from '../../../server/auth/security'
import { hookBus } from '@core/plugins/hookBus'
import type { PublicFormIdentity } from '@core/forms'
import { createDataTable } from '../../../server/repositories/data'
import { loadPublishedRouteInventory } from '../../../server/publish/publishedRoutes'
import { createPublishingTestDb, cleanupPublishingTestDbs } from '../helpers/publishingTestDb'
import { makePage, makeSite } from '../publisher/helpers'

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

async function makeDb(options: { targetTableId?: string; system?: boolean } = {}) {
  const targetTableId = options.targetTableId ?? 'newsletter_submissions'
  const page = makePage({
    body: node('body', 'base.body', {}, ['form']),
    form: node('form', 'base.form', {
      mode: 'cms', formId: 'newsletter', targetTableId,
      honeypotName: 'company', minSubmitSeconds: 0,
    }, ['input']),
    input: node('input', 'base.input', {
      fieldId: 'email', name: 'email', id: 'email-input', inputType: 'email', required: true,
    }),
  }, 'body')
  page.id = 'page-home'
  const db = await createPublishingTestDb(makeSite({ pages: [page] }))
  await createDataTable(db, {
    id: targetTableId,
    name: 'Newsletter submissions', slug: 'newsletter-submissions', kind: 'data',
    routeBase: '', singularLabel: 'Submission', pluralLabel: 'Submissions',
    primaryFieldId: 'email',
    fields: [{ id: 'email', label: 'Email', type: 'email', required: true }],
  })
  if (options.system) await db`update data_tables set system = ${true} where id = ${targetTableId}`
  const route = (await loadPublishedRouteInventory(db)).routes.find((entry) => entry.contentId === page.id)
  if (!route) throw new Error('Form fixture did not publish its originating route')
  const identity: PublicFormIdentity = {
    pageId: route.contentId, localeId: route.localeId,
    publishedVersionId: route.publishedVersionId, pagePath: route.path, formId: 'newsletter',
  }
  return {
    db, identity,
    pageToken: () => issuePublicFormPageToken(identity),
    createdRows: async () => (await db<{ id: string; table_id: string; cells_json: Record<string, unknown> }>`
      select id, table_id, cells_json from data_rows where table_id = ${targetTableId}
    `).rows,
  }
}

function makeThrowingDb(): { db: DbClient; wasQueried: () => boolean } {
  let queried = false
  const handle = async <Row = Record<string, unknown>>(
    _strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    queried = true
    throw new Error('unexpected database query while routing public form request')
  }
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  return { db: handle as DbClient, wasQueried: () => queried }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

describe('public CMS-native form endpoint', () => {
  afterEach(async () => {
    await cleanupPublishingTestDbs()
    resetPublicOrigins()
    hookBus.reset()
  })

  it('router owns public form challenge URLs before public-route/setup fallthrough', async () => {
    resetPublicFormChallenges()
    const { db, identity, pageToken } = await makeDb()

    const response = await handleServerRequest(
      makeRequest(
        '/_instatic/form/challenge',
        { ...identity, pageToken: pageToken() },
        'http://cms.test',
        '203.0.113.40',
      ),
      { db },
    )

    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(typeof body.token).toBe('string')
    expect(typeof body.challenge).toBe('string')
  })

  it('router keeps public form namespace requests from falling through when rejected early', async () => {
    const { db, wasQueried } = makeThrowingDb()

    const response = await handleServerRequest(
      new Request('http://cms.test/_instatic/form/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ formId: 'newsletter', pageId: 'page-home', pageToken: 'unused' }),
      }),
      { db },
    )

    expect(response.status).toBe(403)
    expect(await readJson(response)).toMatchObject({ error: 'Form submissions must come from this site.' })
    expect(wasQueried()).toBe(false)
  })

  it('router treats unknown public form subpaths as submission attempts inside the namespace', async () => {
    const { db, wasQueried } = makeThrowingDb()

    const response = await handleServerRequest(
      makeRequest('/_instatic/form/unknown', { not: 'a submit payload' }, 'http://cms.test', '203.0.113.41'),
      { db },
    )

    expect(response.status).toBe(400)
    expect(await readJson(response)).toMatchObject({ error: 'Invalid form submission payload' })
    expect(wasQueried()).toBe(false)
  })

  it('rejects challenge requests from foreign origins', async () => {
    const { db, identity, pageToken } = await makeDb()
    const response = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', { ...identity, pageToken: pageToken() }, 'https://evil.test'),
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
    const { db, identity, pageToken } = await makeDb()
    const response = await handlePublicFormRequest(
      makeRequest(
        '/_instatic/form/challenge',
        { ...identity, pageToken: pageToken() },
        'https://forms.example.com',
      ),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )

    expect(response?.status).toBe(200)
  })

  it('issues a same-origin challenge and rejects submits without it', async () => {
    resetPublicFormChallenges()
    const { db, identity, pageToken } = await makeDb()
    const challenge = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', { ...identity, pageToken: pageToken() }),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )
    expect(challenge?.status).toBe(200)
    const challengeBody = await readJson(challenge!)
    expect(typeof challengeBody.token).toBe('string')
    expect(typeof challengeBody.challenge).toBe('string')

    const submit = await handlePublicFormRequest(
      makeRequest('/_instatic/form/submit', {
        ...identity,
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
    const { db, identity } = await makeDb()
    const response = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', {
        ...identity,
        pageToken: 'forged',
      }),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )

    expect(response?.status).toBe(403)
  })

  it('rejects oversized challenge payloads before accepting the request', async () => {
    resetPublicFormChallenges()
    const { db, identity, pageToken } = await makeDb()
    const response = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', {
        ...identity,
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
    const { db, identity, pageToken } = await makeDb()
    const ip = '203.0.113.21'
    for (let i = 0; i < 60; i++) {
      const response = await handlePublicFormRequest(
        makeRequest('/_instatic/form/challenge', {
          ...identity,
          pageToken: pageToken(),
        }, 'http://cms.test', ip),
        db,
        new URL('http://cms.test/_instatic/form/challenge'),
      )
      expect(response?.status).toBe(200)
    }

    const limited = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', {
        ...identity,
        pageToken: pageToken(),
      }, 'http://cms.test', ip),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )
    expect(limited?.status).toBe(429)
  })

  it('keeps the in-memory challenge store bounded by evicting oldest entries', () => {
    resetPublicFormChallenges()
    const identity: PublicFormIdentity = { pageId: 'page-home', localeId: 'default', publishedVersionId: 'version-home', pagePath: '/', formId: 'newsletter' }
    const first = issuePublicFormChallenge(identity)
    for (let i = 0; i < 2_000; i++) {
      issuePublicFormChallenge({ ...identity, formId: `newsletter-${i}` })
    }

    expect(verifyAndConsumePublicFormChallenge({
      ...identity,
      challenge: first.challenge,
      token: first.token,
    })).toBeNull()
  })

  it('creates a data row and emits its content event for a valid challenged submission', async () => {
    resetPublicFormChallenges()
    publicFormPerIpRateLimit.reset('unknown')
    publicFormPerFormRateLimit.reset('unknown|newsletter')
    const { db, identity, pageToken, createdRows } = await makeDb()
    const createdEvents: unknown[] = []
    hookBus.on('test.notifications', 'content.entry.created', (payload) => {
      createdEvents.push(payload)
    })
    const challengeResponse = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', { ...identity, pageToken: pageToken() }),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )
    const challenge = await readJson(challengeResponse!)

    const submit = await handlePublicFormRequest(
      makeRequest('/_instatic/form/submit', {
        ...identity,
        token: challenge.token,
        challenge: challenge.challenge,
        values: { email: 'ai@example.com', company: '' },
      }),
      db,
      new URL('http://cms.test/_instatic/form/submit'),
    )

    expect(submit?.status).toBe(200)
    const rows = await createdRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].table_id).toBe('newsletter_submissions')
    expect(rows[0].cells_json).toEqual({ email: 'ai@example.com' })
    expect(createdEvents).toEqual([{
      tableSlug: 'newsletter-submissions',
      entryId: rows[0].id,
      localeId: 'default',
      actor: { kind: 'system' },
    }])
  })

  it('rejects oversized submit payloads before consuming form rate-limit quota', async () => {
    resetPublicFormChallenges()
    publicFormPerIpRateLimit.reset('203.0.113.22')
    publicFormPerFormRateLimit.reset('203.0.113.22|newsletter')
    const { db, identity } = await makeDb()

    const response = await handlePublicFormRequest(
      makeRequest('/_instatic/form/submit', {
        ...identity,
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
    const { db, identity, pageToken, createdRows } = await makeDb({ targetTableId: 'system_submissions', system: true })
    const challengeResponse = await handlePublicFormRequest(
      makeRequest('/_instatic/form/challenge', { ...identity, pageToken: pageToken() }),
      db,
      new URL('http://cms.test/_instatic/form/challenge'),
    )
    const challenge = await readJson(challengeResponse!)

    const submit = await handlePublicFormRequest(
      makeRequest('/_instatic/form/submit', {
        ...identity,
        token: challenge.token,
        challenge: challenge.challenge,
        values: { email: 'ai@example.com', company: '' },
      }),
      db,
      new URL('http://cms.test/_instatic/form/submit'),
    )

    expect(submit?.status).toBe(404)
    expect(await createdRows()).toHaveLength(0)
  })
})
