import { expect, test } from 'bun:test'
import { ServiceGroupRunCreatedSchema } from '@core/serviceAccounts'
import { parseValue } from '@core/utils/typeboxHelpers'
import { createCapabilityTestHarness } from '../../src/__tests__/helpers/capabilityHarness'
import { hashOpaqueToken } from '../oauth/secrets'

test('group consent binds every member and device to one owner-reviewed roster', async () => {
  const h = await createCapabilityTestHarness()
  const base = '/admin/api/cms/service-accounts/'
  try {
    const owner = await h.setupOwner()
    const other = await h.createRoleUser({ name: 'Reviewers', slug: 'reviewers', capabilities: ['ai.providers.manage', 'site.read'] })
    const otherCookie = await h.stepUp(other.cookie)
    const template = { label: 'Site team', members: [
      { label: 'Writer', responsibility: 'Edit text', capabilities: ['site.read', 'site.content.edit'] },
      { label: 'Reviewer', responsibility: 'Check layout', capabilities: ['site.read'] },
    ] }
    const post = (route: string, json: unknown, cookie?: string) => h.cms(base + route, { method: 'POST', json, cookie })
    const get = (route: string, cookie: string) => h.cms(base + route, { cookie })
    expect((await post('groups', template, otherCookie)).status).toBe(403)
    expect((await post('groups', { ...template, members: [{ ...template.members[0], capabilities: ['mail.manage'] }] }, owner)).status).toBe(400)
    const created = await post('groups', template, owner)
    expect(created.status).toBe(201)
    const { id } = await created.json()
    const launch = (branchId: string, cookie = owner) => post('groups/' + id + '/runs', { branchId, ttlHours: 2, task: 'Improve the hero' }, cookie)
    expect((await launch('main')).status).toBe(400)
    expect((await launch('missing')).status).toBe(403)
    expect((await h.cms('/admin/api/cms/branches', { method: 'POST', json: { name: 'review' }, cookie: owner })).status).toBe(201)
    expect((await launch('review', otherCookie)).status).toBe(404)
    const response = await launch('review')
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { run, invites } = parseValue(ServiceGroupRunCreatedSchema, await response.json())
    expect(run.members.map(m => m.label)).toEqual(['Writer', 'Reviewer'])
    expect(new Set(invites.map(i => i.enrollmentKey)).size).toBe(2)
    const edit = (cookie: string) => h.cms(base + 'groups/' + id, { method: 'PUT', json: { ...template, members: template.members.slice(1) }, cookie })
    expect((await edit(otherCookie)).status).toBe(404)
    expect((await edit(owner)).status).toBe(200)
    const summary = await (await get('groups', owner)).json()
    expect(summary.groups[0].members.length).toBe(1)
    expect(summary.runs[0].members.length).toBe(2)
    expect(JSON.stringify(summary)).not.toContain('icli_enroll_')
    expect(await (await get('groups', otherCookie)).json()).toEqual({ groups: [], runs: [] })

    const verifiers = ['a'.repeat(64), 'b'.repeat(64)]
    const proofs = await Promise.all(verifiers.map(hashOpaqueToken))
    const member = (i: number, route: string, body: unknown, cookie?: string) => post(invites[i].accountId + '/' + route, body, cookie)
    const enroll = (i: number, key = invites[i].enrollmentKey, challenge = proofs[i]) =>
      member(i, 'enroll', { runId: run.id, enrollmentKey: key, challenge })
    const poll = (i: number, verifier = verifiers[i]) => member(i, 'poll', { verifier })
    const reviewed = invites.map(({ accountId }, i) => ({ accountId, challenge: proofs[i] }))
    const approve = (members = reviewed, cookie = owner) => post('runs/' + run.id + '/approve', { members }, cookie)
    expect((await member(0, 'approve', { challenge: proofs[0] }, owner)).status).toBe(403)
    expect((await enroll(0, invites[1].enrollmentKey)).status).toBe(401)
    expect((await enroll(0)).status).toBe(200)
    expect((await enroll(0, invites[0].enrollmentKey, proofs[1])).status).toBe(401)
    expect((await approve()).status).toBe(409)
    expect((await poll(0)).status).toBe(202)
    expect((await enroll(1)).status).toBe(200)
    expect((await approve(reviewed, otherCookie)).status).toBe(404)
    expect((await approve(reviewed.slice(1))).status).toBe(409)
    expect((await approve([reviewed[0], reviewed[0]])).status).toBe(409)
    expect((await approve([{ ...reviewed[0], challenge: proofs[1] }, reviewed[1]])).status).toBe(409)
    expect((await approve()).status).toBe(200)
    expect((await approve()).status).toBe(409)
    expect((await enroll(0)).status).toBe(401)
    expect((await poll(0, verifiers[1])).status).toBe(401)
    const issued = await Promise.all([poll(0), poll(0)])
    expect(issued.map(r => r.status).sort()).toEqual([200, 401])
    const tokens = await Promise.all(issued.map(r => r.json()))
    const { token } = tokens.find(t => t.token)
    expect(token).toMatch(/^icli_at_/)
    const secondRun = parseValue(ServiceGroupRunCreatedSchema, await (await launch('review')).json())
    const secondMember = secondRun.invites[0]
    expect((await post(secondMember.accountId + '/enroll', { runId: secondRun.run.id, enrollmentKey: secondMember.enrollmentKey,
      challenge: proofs[1] })).status).toBe(200)
    expect((await post('runs/' + secondRun.run.id + '/approve', {
      members: [{ accountId: secondMember.accountId, challenge: proofs[1] }],
    }, owner)).status).toBe(200)
    const { token: outsider } = await (await post(secondMember.accountId + '/poll', { verifier: verifiers[1] })).json()
    const reviewPath = '/admin/api/cms/branches/review/review'
    const auth = (bearer: string) => ({ Authorization: 'Bearer ' + bearer, 'X-Instatic-Branch': 'review' })
    const teamReview = await (await h.cms(reviewPath, { headers: auth(token) })).json()
    expect(teamReview.assignees.map((a: { accountId: string }) => a.accountId)).toEqual(invites.map(i => i.accountId))
    expect((await (await h.cms(reviewPath, { cookie: owner })).json()).assignees).toHaveLength(3)
    const feedback = { entityKey: '', body: 'Please adjust the heading', assigneeAccountId: invites[1].accountId }
    const comment = (account: string, assigneeAccountId = feedback.assigneeAccountId) => h.cms(reviewPath + '/comments', {
      method: 'POST', headers: auth(account), json: { ...feedback, assigneeAccountId },
    })
    expect((await comment(outsider)).status).toBe(403)
    expect((await comment(token, secondMember.accountId)).status).toBe(403)
    const responseToAuthor = await comment(token)
    expect(responseToAuthor.status).toBe(201)
    const { comment: assigned } = await responseToAuthor.json()
    expect(assigned.assignedTo).toMatchObject({ accountId: invites[1].accountId, label: 'Reviewer' })
    expect(assigned.resolvedAt).toBeNull()
    const closePath = reviewPath + '/comments/' + assigned.id + '/resolve'
    expect((await h.cms(closePath, { method: 'POST', headers: auth(outsider) })).status).toBe(404)
    const resolved = await h.cms(closePath, { method: 'POST', headers: auth(token) })
    expect(resolved.status).toBe(200)
    expect((await resolved.json()).comment.resolvedByUserId).toBe(invites[0].accountId)
    expect((await h.cms(closePath, { method: 'POST', cookie: owner })).status).toBe(404)
    const { comment: forOwner } = await (await comment(token)).json()
    const ownerClose = await h.cms(reviewPath + '/comments/' + forOwner.id + '/resolve', { method: 'POST', cookie: owner })
    expect(ownerClose.status).toBe(200)
    expect((await ownerClose.json()).comment.resolvedAt).toBeString()
    expect((await member(1, 'exchange', { code: 'q'.repeat(50), verifier: verifiers[1] })).status).toBe(401)
    const revoke = (cookie: string) => h.cms(base + 'runs/' + run.id, { method: 'DELETE', cookie })
    expect((await revoke(otherCookie)).status).toBe(404)
    expect((await revoke(owner)).status).toBe(200)
    expect((await poll(1)).status).toBe(401)
    expect((await h.cms('/admin/api/cms/cli-context', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(401)
    expect((await (await get('groups', owner)).json()).runs).toContainEqual(expect.objectContaining({ id: run.id, revoked: true }))
    expect((await (await h.cms(base.slice(0, -1), { cookie: owner })).json()).accounts).toEqual([])

    const next = parseValue(ServiceGroupRunCreatedSchema, await (await launch('review')).json())
    expect(next.run.members.map(m => m.label)).toEqual(['Reviewer'])
    const device = next.invites[0]
    const enrollNext = () => post(device.accountId + '/enroll', { runId: next.run.id, enrollmentKey: device.enrollmentKey, challenge: proofs[0] })
    expect((await enrollNext()).status).toBe(200)
    await h.db`update service_account_runs set expires_at = ${new Date(0).toISOString()} where id = ${next.run.id}`
    expect((await enrollNext()).status).toBe(401)
    expect((await post(device.accountId + '/poll', { verifier: verifiers[0] })).status).toBe(401)
    expect((await post('runs/' + next.run.id + '/approve', { members: [{ accountId: device.accountId, challenge: proofs[0] }] }, owner)).status).toBe(409)
  } finally {
    await h.cleanup()
  }
})
