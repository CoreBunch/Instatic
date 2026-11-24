import { expect, test } from 'bun:test'
import { createCapabilityTestHarness } from '../../src/__tests__/helpers/capabilityHarness'
import { pkceChallengeForVerifier } from '../oauth/secrets'

test('a group member can work only with its live grant on the assigned review branch', async () => {
  const h = await createCapabilityTestHarness()
  try {
    const cms = '/admin/api/cms/'
    const accounts = cms + 'service-accounts/'
    await h.setupOwner()
    const sponsor = await h.createRoleUser({ name: 'Team leader', slug: 'team-leader',
      capabilities: ['ai.providers.manage', 'site.branches.create', 'site.read', 'site.content.edit'] })
    const cookie = await h.stepUp(sponsor.cookie)
    const post = (path: string, json: unknown) => h.cms(path, { method: 'POST', cookie, json })
    const branchId = 'team-review'
    expect((await post(cms + 'branches', { name: branchId })).status).toBe(201)
    const created = await post(accounts + 'groups', { label: 'Release team', members: [
      { label: 'Writer', responsibility: 'Edit homepage copy', capabilities: ['site.read', 'site.content.edit'] },
      { label: 'Reviewer', responsibility: 'Check homepage copy', capabilities: ['site.read'] },
    ] })
    expect(created.status).toBe(201)
    const groupId = (await created.json()).id
    const started = await post(accounts + 'groups/' + groupId + '/runs', { branchId, ttlHours: 1, task: 'Review launch' })
    expect(started.status).toBe(201)
    const { run, invites } = await started.json()
    const devices = []
    for (const invite of invites) {
      const verifier = crypto.randomUUID() + crypto.randomUUID()
      const challenge = await pkceChallengeForVerifier(verifier)
      const path = accounts + invite.accountId
      expect((await h.cms(path + '/enroll', { method: 'POST', json: { enrollmentKey: invite.enrollmentKey, runId: run.id, challenge } })).status).toBe(200)
      expect((await h.cms(path + '/poll', { method: 'POST', json: { verifier } })).status).toBe(202)
      devices.push({ accountId: invite.accountId, challenge, verifier })
    }
    expect((await post(accounts + 'runs/' + run.id + '/approve', {
      members: devices.map(({ accountId, challenge }) => ({ accountId, challenge })),
    })).status).toBe(200)
    const tokens = []
    for (const { accountId, verifier } of devices) {
      const exchanged = await h.cms(accounts + accountId + '/poll', { method: 'POST', json: { verifier } })
      expect(exchanged.status).toBe(200)
      tokens.push((await exchanged.json()).token)
    }
    const auth = { Authorization: 'Bearer ' + tokens[0] }
    const headers = { ...auth, 'X-Instatic-Branch': branchId }
    const reviewer = { ...headers, Authorization: 'Bearer ' + tokens[1] }
    const read = (path: string) => h.cms(cms + path, { headers })
    const review = 'branches/' + branchId + '/review'
    const context = await (await h.cms(cms + 'cli-context?guide=membership', { headers: auth })).json()
    expect(context.group).toMatchObject({ runId: run.id, branchId, responsibility: 'Edit homepage copy' })
    expect(context.scope).toBe('branch')
    expect(context.guide).toBeUndefined()
    expect(context.operations).toContainEqual(expect.objectContaining({ method: 'GET', path: 'canvas/visitor' }))
    expect(context.operations).toContainEqual(expect.objectContaining({ method: 'PATCH', path: 'canvas/pages/:id' }))
    expect(context.operations).not.toContainEqual(expect.objectContaining({ path: 'branches' }))
    expect((await read('branches/' + branchId + '/merge')).status).toBe(200)
    expect((await read(review)).status).toBe(200)
    expect((await read('canvas/catalog')).status).toBe(200)
    expect((await read('canvas/visitor?path=/missing-page')).status).toBe(404)
    const comment = await h.cms(cms + review + '/comments', { headers: reviewer, method: 'POST', json: { entityKey: '', body: 'Reviewed.' } })
    expect(comment.status).toBe(201)
    expect((await comment.json()).comment.author.id).toBe(devices[1].accountId)
    expect((await h.cms(cms + 'canvas/pages/id', { method: 'PATCH', headers: reviewer })).status).toBe(403)
    expect((await h.cms(cms + 'canvas/pages/id', { method: 'PATCH', headers })).status).toBe(404)
    for (const branch of [undefined, 'main', 'unassigned']) {
      expect((await h.cms(cms + 'canvas/catalog', { headers: branch ? { ...auth, 'X-Instatic-Branch': branch } : auth })).status).toBe(403)
    }
    for (const path of ['site', 'publish/status', 'members/settings', 'canvas/future', 'branches/unassigned/review',
      'branches/main/merge', review + '/render?row=id&side=main']) expect((await read(path)).status).toBe(403)
    for (const path of ['publish', 'branches', 'branches/' + branchId + '/merge', 'branches/' + branchId + '/preview']) {
      expect((await h.cms(cms + path, { headers, method: 'POST' })).status).toBe(403)
    }
    expect((await h.ai('/admin/api/ai/providers', { headers })).status).toBe(403)
    await h.db`update roles set capabilities_json = ${JSON.stringify(['site.read', 'ai.providers.manage', 'site.branches.create'])} where id = ${sponsor.roleId}`
    expect((await h.cms(cms + 'canvas/pages/id', { method: 'PATCH', headers })).status).toBe(403)
    await h.db`update roles set capabilities_json = ${JSON.stringify(['site.read', 'ai.providers.manage'])} where id = ${sponsor.roleId}`
    expect((await read('canvas/catalog')).status).toBe(401)
  } finally {
    await h.cleanup()
  }
})
