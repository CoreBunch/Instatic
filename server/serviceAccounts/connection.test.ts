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
      capabilities: ['ai.providers.manage', 'site.branches.create', 'site.read', 'site.content.edit', 'site.structure.edit'] })
    const cookie = await h.stepUp(sponsor.cookie)
    const input = { label: 'Launch editor', ttlHours: 2, capabilities: ['site.read', 'site.content.edit', 'site.branches.create'] }
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
    expect((await h.cms(base + 'cli-context', { headers })).status).toBe(200)
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
      site, shellBaseSeq: 0, baseSeqs: {}, mode: 'incremental', changedPages: [page], deletedPageIds: [],
      changedComponents: [], deletedComponentIds: [], changedLayouts: [], deletedLayoutIds: [],
    } })
    expect(save.status).toBe(200)
    const fork = await h.cms(base + 'branches', { method: 'POST', headers, json: { name: 'review' } })
    expect(fork.status).toBe(201)
    expect((await fork.json()).branch.createdByUserId).toBe(id)
    const read = () => h.cms(base + 'draft-page/hero-page', { headers: branch })
    const payload = await (await read()).json()
    payload.changedPages[0].nodes.heading.props.text = 'May'
    const write = () => h.cms(base + 'site-document', { method: 'PUT', headers: branch, json: payload })
    expect((await write()).status).toBe(200)
    expect((await write()).status).toBe(409)
    expect((await (await read()).json()).changedPages[0].nodes.heading.props.text).toBe('May')
    const main = await h.cms(base + 'draft-page/hero-page', { headers })
    expect((await main.json()).changedPages[0].nodes.heading.props.text).toBe('April')
    await h.db`update roles set capabilities_json = ${JSON.stringify(['site.read', 'ai.providers.manage'])} where id = ${sponsor.roleId}`
    expect((await write()).status).toBe(403)
    const future = new Date(Date.now() + 7200000).toISOString()
    await h.db`update service_accounts set expires_at = ${new Date(0).toISOString()} where id = ${id}`
    expect((await read()).status).toBe(401)
    await h.db`update service_accounts set expires_at = ${future} where id = ${id}`
    const pending = await (await approve()).json()
    await h.db`update roles set capabilities_json = ${JSON.stringify(['site.read'])} where id = ${sponsor.roleId}`
    expect((await exchange(pending.code, verifier)).status).toBe(401)
    await h.db`update roles set capabilities_json = ${JSON.stringify(['site.read', 'ai.providers.manage'])} where id = ${sponsor.roleId}`
    expect((await h.cms(path + '/' + id, { cookie, method: 'DELETE' })).status).toBe(200)
    expect((await read()).status).toBe(401)
    expect((await exchange(pending.code, verifier)).status).toBe(401)
  } finally { await h.cleanup() }
})

test('CMS operations use role permissions and the confirmation window of the paired device', async () => {
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

    await h.db`update service_accounts set token_step_up_expires_at = ${new Date(0).toISOString()} where id = ${id}`
    const nextApproval = await approve()
    const stale = await install(first)
    expect(stale.status).toBe(401)
    expect(await stale.json()).toEqual({ error: 'step_up_required' })
    expect((await h.cms(base + 'dashboard/domain', { headers: first })).status).toBe(200)
    const second = await exchange(nextApproval)
    expect((await install(first)).status).toBe(401)
    expect((await install(second)).status).toBe(201)
  } finally { await h.cleanup() }
})
