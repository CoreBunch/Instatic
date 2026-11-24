import { expect, test } from 'bun:test'
import { createCapabilityTestHarness } from '../../src/__tests__/helpers/capabilityHarness'
import { findUserByEmail } from '../repositories/users'
import { pkceChallengeForVerifier } from '../oauth/secrets'

test('CLI approval grants an expiring, revocable identity that can fork and edit a branch', async () => {
  const h = await createCapabilityTestHarness()
  const base = '/admin/api/cms/'
  const path = base + 'service-accounts'
  try {
    const owner = await h.setupOwner()
    const sponsor = await h.createRoleUser({ name: 'Site agents', slug: 'site-agents',
      capabilities: ['ai.providers.manage', 'ai.chat', 'site.branches.create', 'site.read', 'site.content.edit', 'site.structure.edit'] })
    let cookie = await h.stepUp(sponsor.cookie)
    const input = { label: 'Launch editor', ttlHours: 2, capabilities: ['ai.chat', 'site.read', 'site.content.edit', 'site.branches.create'] }
    expect((await h.cms(path, { cookie, method: 'POST', json: { ...input, capabilities: ['mail.manage'] } })).status).toBe(403)
    const created = await h.cms(path, { cookie, method: 'POST', json: input })
    expect(created.status).toBe(201)
    const { id } = await created.json()
    expect(await findUserByEmail(h.db, id + '@service.invalid')).toBeNull()
    const verifier = 'p'.repeat(64)
    const challenge = await pkceChallengeForVerifier(verifier)
    const approve = () => h.cms(path + '/' + id + '/approve', { method: 'POST', cookie, json: { challenge } })
    const exchange = (code: string, proof: string) => h.cms(path + '/' + id + '/exchange', {
      method: 'POST', json: { code, verifier: proof },
    })
    const wrongOwner = await h.cms(path + '/' + id + '/approve', {
      method: 'POST', cookie: owner, json: { challenge },
    })
    expect(wrongOwner.status).toBe(403)
    const { code } = await (await approve()).json()
    expect((await exchange(code, 'x'.repeat(64))).status).toBe(401)
    const { token } = await (await exchange(code, verifier)).json()
    expect((await exchange(code, verifier)).status).toBe(401)
    const headers = { Authorization: 'Bearer ' + token }
    const branch = { ...headers, 'X-Instatic-Branch': 'review' }
    const discovery = await h.cms(base + 'cli-context?guide=membership', { headers })
    expect(discovery.status).toBe(200)
    const { guide, operations } = await discovery.json()
    expect(guide.state).toBeNull()
    expect(guide.steps.at(-1).unavailable).toBe(true)
    expect(operations).toContainEqual(expect.objectContaining({ path: 'pages', method: 'GET' }))
    expect((await h.ai('/admin/api/ai/credentials', { headers })).status).toBe(403)
    expect((await h.cms(base + 'cli-context', { headers, cookie })).status).toBe(403)
    expect((await h.cms(base + 'me', { headers })).status).toBe(403)
    expect((await h.cms(base + 'mail', { headers })).status).toBe(403)
    const { site } = await (await h.cms(base + 'site', { cookie: owner })).json()
    const page = { id: 'hero-page', title: 'Launch', slug: 'launch', rootNodeId: 'body', nodes: {
      body: { id: 'body', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['heading'] },
      heading: { id: 'heading', moduleId: 'base.text', props: { text: 'April' }, breakpointOverrides: {}, children: [] },
    } }
    const save = await h.cms(base + 'site-document', { cookie: owner, method: 'PUT', json: {
      site, shellBaseSeq: 0, baseSeqs: {}, mode: 'incremental', changedPages: [page,
        { ...page, id: 'private', slug: 'private', access: { level: 'members', onDeny: 'login' } },
        { ...page, id: 'hidden', slug: 'hidden', access: { level: 'tags', tags: ['pro'], onDeny: 'hide' } },
      ], deletedPageIds: [],
      changedComponents: [], deletedComponentIds: [], changedLayouts: [], deletedLayoutIds: [],
    } })
    expect(save.status).toBe(200)
    const fork = await h.cms(base + 'branches', { method: 'POST', headers, json: { name: 'review' } })
    expect(fork.status).toBe(201)
    expect((await fork.json()).branch.createdByUserId).toBe(id)
    const aiWrite = { headers: branch, method: 'POST', json: {} }
    const unknownBranch = await h.ai('/admin/api/ai/chat/site', { ...aiWrite, headers: { ...headers, 'X-Instatic-Branch': 'missing' } })
    expect(await unknownBranch.json()).toMatchObject({ code: 'branch_not_found' })
    expect(await (await h.ai('/admin/api/ai/chat/site', aiWrite)).json()).toEqual({ error: 'Invalid request body.' })
    expect(await (await h.ai('/admin/api/ai/conversations', aiWrite)).json()).toMatchObject({ error: expect.stringContaining('installation-wide') })
    const visitor = base + 'canvas/visitor?path=/launch'
    expect((await h.cms(visitor, { headers })).status).toBe(400)
    expect((await h.cms(visitor, { headers: branch })).status).toBe(200)
    const visit = (path: string) => h.cms(base + 'canvas/visitor?path=' + path, { headers: branch })
    expect((await visit('/private')).status).toBe(403)
    expect((await visit('/hidden')).status).toBe(404)
    const other = await h.cms(base + 'branches', { method: 'POST', cookie: owner, json: { name: 'other-review' } })
    expect(other.status).toBe(201)
    expect((await h.cms(visitor, { headers: { ...headers, 'X-Instatic-Branch': 'other-review' } })).status).toBe(403)
    expect((await h.cms(base + 'canvas/visitor?path=/%25zz', { headers: branch })).status).toBe(400)
    const read = () => h.cms(base + 'draft-page/hero-page', { headers: branch })
    const payload = await (await read()).json()
    payload.changedPages[0].nodes.heading.props.text = 'May'
    const write = () => h.cms(base + 'site-document', { method: 'PUT', headers: branch, json: payload })
    const saved = await write()
    expect(saved.status).toBe(200)
    const { pages: [receipt] } = await saved.json()
    const batch = await h.cms(base + 'canvas/pages?ref=%2Flaunch&ref=hero-page', { headers: branch })
    expect(batch.status).toBe(200)
    const snapshot = await batch.json()
    expect(snapshot.pages).toEqual([{ ...receipt, access: { level: 'public' } }])
    expect(snapshot.document.changedPages).toHaveLength(1)
    expect((await write()).status).toBe(409)
    expect((await (await read()).json()).changedPages[0].nodes.heading.props.text).toBe('May')
    const main = await h.cms(base + 'draft-page/hero-page', { headers })
    expect((await main.json()).changedPages[0].nodes.heading.props.text).toBe('April')
    const canvas = base + 'canvas/pages/hero-page'
    const inspection = await h.cms(canvas, { headers: branch })
    expect(inspection.status).toBe(200)
    const { revision, nodes } = await inspection.json()
    expect(revision).toBe(receipt.revision)
    expect(nodes).toContainEqual(expect.objectContaining({ node: 'heading', module: 'base.text' }))
    const edit = (edits: unknown[], rev = revision, grant = branch as Record<string, string>) =>
      h.cms(canvas, { headers: grant, method: 'PATCH', json: { revision: rev, edits } })
    const title = { op: 'text', node: 'heading', value: 'June' }
    expect((await edit([title], revision, headers)).status).toBe(400)
    expect((await edit([title, { op: 'inline', node: 'heading', property: 'color', value: 'red' }])).status).toBe(403)
    expect((await edit([title, { ...title, node: 'missing' }])).status).toBe(400)
    expect((await (await read()).json()).changedPages[0].nodes.heading.props.text).toBe('May')
    expect((await edit([title])).status).toBe(200)
    expect((await edit([title])).status).toBe(409)
    const activity = path + '/' + id + '/activity'
    const recorded = await (await h.cms(activity, { cookie })).json()
    expect(recorded.events).toContainEqual(expect.objectContaining({ title: 'Edited a page', scope: 'review', status: 200, agent: 'Launch editor' }))
    expect(recorded.events).toContainEqual(expect.objectContaining({ status: 409 }))
    expect(JSON.stringify(recorded)).not.toContain('April')
    expect((await (await h.cms(activity, { cookie: owner })).json()).events).toEqual([])
    const ownerBranch = { 'X-Instatic-Branch': 'review' }
    const current = await (await h.cms(canvas, { cookie: owner, headers: ownerBranch })).json()
    const insert = await h.cms(canvas, { cookie: owner, headers: ownerBranch, method: 'PATCH', json: {
      revision: current.revision, edits: [{ op: 'insertHtml', parent: 'body', html: '<style>.notice { color: red }</style><p class="notice">See you there</p>' }],
    } })
    expect(insert.status).toBe(200)
    const { revision: next } = await insert.json()
    const imported = await (await h.cms(canvas, { headers: branch })).json()
    expect(imported.revision).toBe(next)
    expect(imported.html).toContain('See you there')
    expect(imported.rules).toContainEqual(expect.objectContaining({ selector: '.notice', styles: expect.objectContaining({ color: 'red' }) }))
    const rule = imported.rules.find((item: { selector: string }) => item.selector === '.notice')
    const responsive = await h.cms(canvas, { cookie: owner, headers: ownerBranch, method: 'PATCH', json: {
      revision: imported.revision, edits: [{ op: 'rule', rule: rule.id, context: 'mobile', property: 'white-space', value: 'normal' }],
    } })
    expect(responsive.status).toBe(200)
    expect((await responsive.json()).changes[0]).toMatchObject({ property: 'whiteSpace', before: null, after: 'normal' })
    const updated = await (await h.cms(canvas, { headers: branch })).json()
    expect(updated.rules).toContainEqual(expect.objectContaining({ id: rule.id, contexts: { mobile: { whiteSpace: 'normal' } } }))
    const formEdit = await h.cms(base + 'canvas/pages/%2Flaunch', { cookie: owner, headers: ownerBranch, method: 'PATCH', json: {
      revision: updated.revision, edits: [{ op: 'memberForm', parent: 'body', action: 'verify' }],
    } })
    expect(formEdit.status).toBe(200)
    const withForm = await (await h.cms(canvas, { headers: branch })).json()
    expect(withForm.html).toContain('/_instatic/members/verify')
    expect(withForm.html).toContain('name="token"')
    expect(withForm.html).toMatch(/<div[^>]*data-instatic-form-message="success"[^>]*\bhidden\b/)
    expect((await edit([title], imported.revision)).status).toBe(409)
    expect((await (await h.cms(canvas, { headers })).json()).html).not.toContain('See you there')
    await h.db`update roles set capabilities_json = ${JSON.stringify(['site.read', 'ai.providers.manage'])} where id = ${sponsor.roleId}`
    expect((await write()).status).toBe(403)
    expect((await h.cms(visitor, { headers: branch })).status).toBe(403)
    const renew = (session: string, ttlHours: number) => h.cms(path + '/' + id + '/renew', {
      method: 'POST', cookie: session, json: { ttlHours },
    })
    const staleApproval = await (await approve()).json()
    expect((await renew(cookie, 8)).status).toBe(409)
    await h.db`update service_accounts set expires_at = ${new Date(0).toISOString()} where id = ${id}`
    expect((await read()).status).toBe(401)
    expect((await renew(owner, 8)).status).toBe(409)
    expect((await renew(cookie, 721)).status).toBe(400)
    const freshLogin = await h.sessionForEmail(sponsor.email)
    await h.db`update sessions set step_up_expires_at = null where user_id = (select owner_id from service_accounts where id = ${id})`
    expect(await (await renew(freshLogin, 8)).json()).toEqual({ error: 'step_up_required' })
    cookie = await h.stepUp(freshLogin)
    const started = Date.now()
    const res = await renew(cookie, 8)
    expect(res.status).toBe(200)
    const { expiresAt } = await res.json()
    expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(started + 8 * 3600000)
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(Date.now() + 8 * 3600000)
    expect((await renew(cookie, 8)).status).toBe(409)
    expect((await exchange(staleApproval.code, verifier)).status).toBe(401)
    expect((await read()).status).toBe(200)
    expect((await write()).status).toBe(403)
    const renewed = await (await h.cms(activity, { cookie })).json()
    expect(renewed.events.filter((event: { title: string }) => event.title === 'Access renewed'))
      .toEqual([expect.objectContaining({ expiresAt })])
    await h.db`update service_accounts set expires_at = ${new Date(0).toISOString()} where id = ${id}`
    expect((await read()).status).toBe(401)
    expect((await renew(cookie, 1)).status).toBe(200)
    const pending = await (await approve()).json()
    await h.db`update roles set capabilities_json = ${JSON.stringify(['site.read'])} where id = ${sponsor.roleId}`
    expect((await exchange(pending.code, verifier)).status).toBe(401)
    await h.db`update roles set capabilities_json = ${JSON.stringify(['site.read', 'ai.providers.manage'])} where id = ${sponsor.roleId}`
    expect((await h.cms(path + '/' + id, { cookie, method: 'DELETE' })).status).toBe(200)
    expect((await read()).status).toBe(401)
    expect((await exchange(pending.code, verifier)).status).toBe(401)
    await h.db`update service_accounts set expires_at = ${new Date(0).toISOString()} where id = ${id}`
    expect((await renew(cookie, 8)).status).toBe(409)
    expect((await read()).status).toBe(401)
  } finally { await h.cleanup() }
})

test('CMS operations use role permissions throughout the lifetime of the paired device grant', async () => {
  const h = await createCapabilityTestHarness()
  const base = '/admin/api/cms/'
  const accounts = base + 'service-accounts'
  try {
    const cookie = await h.setupOwner()
    const input = { label: 'Plugin installer', ttlHours: 2, capabilities: ['plugins.install', 'dashboard.read', 'users.manage'] }
    const create = (capabilities: string[]) => h.cms(accounts, { method: 'POST', cookie, json: { ...input, capabilities } })
    expect((await create(['roles.manage'])).status).toBe(400)
    const { id } = await (await create(input.capabilities)).json()
    const verifier = 'k'.repeat(64)
    const challenge = await pkceChallengeForVerifier(verifier)
    const approve = async () => (await (await h.cms(accounts + '/' + id + '/approve', {
      method: 'POST', cookie, json: { challenge },
    })).json()).code
    const exchange = async (code: string) => {
      const exchanged = await h.cms(accounts + '/' + id + '/exchange', { method: 'POST', json: { code, verifier } })
      expect(exchanged.status).toBe(200)
      return { Authorization: 'Bearer ' + (await exchanged.json()).token }
    }
    const first = await exchange(await approve())
    const manifest = { id: 'fixture.cli', name: 'Fixture', version: '1.0.0', apiVersion: 1, permissions: [] }
    const install = (headers: HeadersInit) => h.cms(base + 'plugins', { method: 'POST', headers, json: { manifest } })
    expect((await install(first)).status).toBe(201)
    expect((await h.cms(base + 'dashboard/domain', { headers: first })).status).toBe(200)
    expect((await h.cms(base + 'dashboard/plugins', { headers: first })).status).toBe(403)
    expect((await h.cms(base + 'plugins', { headers: first })).status).toBe(403)
    expect((await h.cms(base + 'roles', { method: 'POST', headers: first })).status).toBe(403)
    expect((await h.cms(accounts, { headers: first })).status).toBe(403)
    expect((await h.cms(base + 'users/' + id, { method: 'DELETE', headers: first })).status).toBe(404)
    const publisher = await h.createRoleUser({ name: 'Publisher', slug: 'publisher', capabilities: ['pages.publish'] })
    const target = await findUserByEmail(h.db, publisher.email)
    expect(target).toBeTruthy()
    expect((await h.cms(base + 'users/' + target!.id, {
      method: 'PATCH', headers: first, json: { email: 'changed@example.test' },
    })).status).toBe(403)

    const nextApproval = await approve()
    const repeat = await h.cms(base + 'plugins', { method: 'POST', headers: first, json: { manifest: { ...manifest, id: 'fixture.second' } } })
    expect(repeat.status).toBe(201)
    expect((await h.cms(base + 'dashboard/domain', { headers: first })).status).toBe(200)
    const second = await exchange(nextApproval)
    expect((await install(first)).status).toBe(401)
    expect((await install(second)).status).toBe(201)
  } finally { await h.cleanup() }
})
