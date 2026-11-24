import { canActOnBranch, MAIN_BRANCH_ID } from '@core/branches'
import { ServiceGroupApproveSchema, ServiceGroupEnrollSchema, ServiceGroupInputSchema, ServiceGroupPollSchema,
  ServiceGroupRunInputSchema, type ServiceGroup } from '@core/serviceAccounts'
import { capabilitiesUserCannotGrant, requireCapability, requireStepUp } from '../auth/authz'
import type { DbClient } from '../db/client'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../http'
import { getBranch } from '../repositories/branches'
import type { AuthUser } from '../repositories/users'
import { approveGroupRun, createGroupRun, enrollMember, getGroup, groupRuns, listGroups, pollMember,
  revokeGroupRun, saveGroup } from './groups'

const notFound = () => jsonResponse({ error: 'Group or run not found' }, { status: 404 })
const forbidden = () => jsonResponse({ error: 'The branch or requested permissions exceed your role' }, { status: 403 })

function canDelegate(user: AuthUser, members: ServiceGroup['members']) {
  return members.every(m => !capabilitiesUserCannotGrant(user, m.capabilities).length)
}

async function canAssignBranch(db: DbClient, user: AuthUser, branchId: string | null) {
  if (!branchId || branchId === MAIN_BRANCH_ID) return false
  const branch = await getBranch(db, branchId)
  return !!branch && canActOnBranch(user, branch)
}

export async function handleGroupDevice(req: Request, db: DbClient, accountId: string, action: string, issuer: string | null) {
  if (req.method !== 'POST') return methodNotAllowed()
  if (!issuer) return badRequest('Configure PUBLIC_ORIGIN to connect a CLI')
  if (action === 'enroll') {
    const body = await readValidatedBody(req, ServiceGroupEnrollSchema)
    if (!body) return badRequest('Invalid enrollment request')
    if (await enrollMember(db, accountId, body.runId, body.enrollmentKey, body.challenge)) return jsonResponse({ ok: true })
  } else {
    const body = await readValidatedBody(req, ServiceGroupPollSchema)
    if (!body) return badRequest('Invalid device proof')
    const result = await pollMember(db, accountId, body.verifier)
    if (result) return Response.json(result, {
      status: 'token' in result ? 200 : 202, headers: { 'Cache-Control': 'no-store' },
    })
  }
  return jsonResponse({ error: 'Device enrollment is invalid, expired or already used' }, { status: 401 })
}

export async function handleGroupManagement(req: Request, db: DbClient, part: string, issuer: string | null) {
  const user = await requireCapability(req, db, 'ai.providers.manage')
  if (user instanceof Response) return user
  const [resource, id, action, extra] = part.split('/')
  if (extra !== undefined) return notFound()
  if (resource === 'groups') {
    if (id !== undefined && !/^grp_[a-f0-9-]{36}$/.test(id)) return notFound()
    if (!id && req.method === 'GET') {
      const [groups, runs] = await Promise.all([listGroups(db, user.id), groupRuns(db, user.id)])
      return jsonResponse({ groups, runs })
    }
    if ((!id && req.method === 'POST') || (id && !action && req.method === 'PUT')) {
      const body = await readValidatedBody(req, ServiceGroupInputSchema)
      if (!body) return badRequest('Enter a group name and a role, responsibility and permissions for each agent')
      if (new Set(body.members.map(m => m.label.trim().toLowerCase())).size !== body.members.length) return badRequest('Each agent needs a unique name')
      if (!canDelegate(user, body.members)) return forbidden()
      const groupId = await saveGroup(db, id ?? null, user.id, body)
      return groupId ? jsonResponse({ id: groupId }, { status: id ? 200 : 201 }) : notFound()
    }
    if (id && action === 'runs' && req.method === 'POST') {
      if (!issuer) return badRequest('Configure PUBLIC_ORIGIN to start a group run')
      const body = await readValidatedBody(req, ServiceGroupRunInputSchema)
      if (!body || body.branchId === MAIN_BRANCH_ID) return badRequest('Choose a review branch, enter a task and set an expiry')
      const step = await requireStepUp(req, db, user, { policy: 'always' })
      if (step) return step
      return db.transaction(async tx => {
        const group = await getGroup(tx, id, user.id)
        if (!group) return notFound()
        if (!canDelegate(user, group.members) || !await canAssignBranch(tx, user, body.branchId)) return forbidden()
        const created = await createGroupRun(tx, user.id, group, body)
        return Response.json(created, { status: 201, headers: { 'Cache-Control': 'no-store' } })
      })
    }
  }
  if (resource === 'runs') {
    if (!id || !/^run_[a-f0-9-]{36}$/.test(id)) return notFound()
    if (!action && req.method === 'DELETE') {
      return await db.transaction(tx => revokeGroupRun(tx, user.id, id)) ? jsonResponse({ ok: true }) : notFound()
    }
    if (action === 'approve' && req.method === 'POST') {
      if (!issuer) return badRequest('Configure PUBLIC_ORIGIN to authorize the agents')
      const body = await readValidatedBody(req, ServiceGroupApproveSchema)
      if (!body) return badRequest('Review every enrolled device before approving the group')
      const step = await requireStepUp(req, db, user, { policy: 'always' })
      if (step) return step
      return db.transaction(async tx => {
        const [run] = await groupRuns(tx, user.id, id)
        if (!run) return notFound()
        if (!canDelegate(user, run.members) || !await canAssignBranch(tx, user, run.branchId)) return forbidden()
        return await approveGroupRun(tx, user.id, run, body) ? jsonResponse({ ok: true }) :
          jsonResponse({ error: 'Review the current roster. Each device must enroll before approval and the run must still be pending.' }, { status: 409 })
      })
    }
  }
  return methodNotAllowed()
}
