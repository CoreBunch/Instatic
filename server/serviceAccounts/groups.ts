import { randomUUID } from 'node:crypto'
import { ServiceGroupInputSchema, type ServiceGroup, type ServiceGroupRun, type ServiceGroupRunInputSchema,
  type ServiceGroupApproveSchema } from '@core/serviceAccounts'
import { parseValue, type Static } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../db/client'
import { generateOpaqueToken, hashOpaqueToken } from '../oauth/secrets'
import { createAuditEvent } from '../repositories/audit'
import { findUserById } from '../repositories/users'
import { createAccount } from './store'

type GroupInput = Static<typeof ServiceGroupInputSchema>
type RunInput = Static<typeof ServiceGroupRunInputSchema>
interface GroupRow { id: string; label: string; members_json: unknown }

function groupView(row: GroupRow): ServiceGroup {
  return { id: row.id, label: row.label, members: parseValue(ServiceGroupInputSchema.properties.members, row.members_json) }
}

export async function listGroups(db: DbClient, owner: string) {
  const { rows } = await db<GroupRow>`select id, label, members_json from service_account_groups
    where owner_id = ${owner} order by label, id`
  return rows.map(groupView)
}

export async function getGroup(db: DbClient, id: string, owner: string) {
  const { rows } = await db<GroupRow>`select id, label, members_json from service_account_groups
    where id = ${id} and owner_id = ${owner}`
  return rows[0] && groupView(rows[0])
}

export async function saveGroup(db: DbClient, id: string | null, owner: string, input: GroupInput) {
  const label = input.label.trim()
  const members = input.members.map(m => ({ ...m, label: m.label.trim(), responsibility: m.responsibility.trim() }))
  if (id) {
    const result = await db`update service_account_groups set label = ${label}, members_json = ${members}
      where id = ${id} and owner_id = ${owner}`
    return result.rowCount ? id : null
  }
  const newId = 'grp_' + randomUUID()
  await db`insert into service_account_groups(id, owner_id, label, members_json)
    values (${newId}, ${owner}, ${label}, ${members})`
  return newId
}

interface RunMemberRow {
  id: string
  group_id: string
  branch_id: string | null
  task: string
  expires_at: string
  approved_at: string | null
  revoked_at: string | null
  account_id: string
  label: string
  responsibility: string
  capabilities_json: unknown
  code_challenge: string | null
  connected: number
}

export async function groupRuns(db: DbClient, owner: string, runId = '') {
  const { rows } = await db<RunMemberRow>`select r.id, r.group_id, r.branch_id, r.task, r.expires_at,
    r.approved_at, r.revoked_at, a.id as account_id, a.label, a.responsibility, a.capabilities_json, a.code_challenge,
    case when a.token_hash is null then 0 else 1 end as connected
    from service_account_runs r join service_account_groups g on g.id = r.group_id
    join service_accounts a on a.group_run_id = r.id
    where g.owner_id = ${owner} and (${runId} = '' or r.id = ${runId})
    order by r.created_at desc, r.id, a.group_position`
  const runs = new Map<string, ServiceGroupRun>()
  for (const row of rows) {
    let run = runs.get(row.id)
    if (!run) {
      run = { id: row.id, groupId: row.group_id, branchId: row.branch_id, task: row.task, approved: !!row.approved_at,
        revoked: !!row.revoked_at, expired: Date.parse(row.expires_at) <= Date.now(), expiresAt: row.expires_at, members: [] }
      runs.set(row.id, run)
    }
    const capabilities = parseValue(ServiceGroupInputSchema.properties.members.items.properties.capabilities, row.capabilities_json)
    run.members.push({ accountId: row.account_id, label: row.label, responsibility: row.responsibility, capabilities,
      challenge: row.code_challenge, connected: Boolean(row.connected) })
  }
  return [...runs.values()]
}

export async function createGroupRun(tx: DbClient, owner: string, group: ServiceGroup, input: RunInput) {
  const id = 'run_' + randomUUID()
  const now = Date.now()
  const expiresAt = new Date(now + input.ttlHours * 3600000).toISOString()
  await tx`insert into service_account_runs(id, group_id, branch_id, task, created_at, expires_at)
    values (${id}, ${group.id}, ${input.branchId}, ${input.task.trim()}, ${new Date(now).toISOString()}, ${expiresAt})`
  const invites = []
  for (const [position, member] of group.members.entries()) {
    const accountId = await createAccount(tx, owner, { ...member, ttlHours: input.ttlHours })
    const enrollmentKey = generateOpaqueToken('icli_enroll_')
    await tx`update service_accounts set group_run_id = ${id}, group_position = ${position},
      responsibility = ${member.responsibility}, expires_at = ${expiresAt}, enrollment_key_hash = ${await hashOpaqueToken(enrollmentKey)}
      where id = ${accountId}`
    invites.push({ accountId, enrollmentKey })
    await createAuditEvent(tx, { actorUserId: owner, action: 'service_account.created', targetType: 'service_account',
      targetId: accountId, metadata: { runId: id, groupId: group.id, branchId: input.branchId, label: member.label, capabilities: member.capabilities } })
  }
  const [run] = await groupRuns(tx, owner, id)
  return { run, invites }
}

export async function enrollMember(db: DbClient, accountId: string, runId: string, key: string, challenge: string) {
  const now = new Date().toISOString()
  const result = await db`update service_accounts set code_challenge = ${challenge}
    where id = ${accountId} and group_run_id = ${runId} and enrollment_key_hash = ${await hashOpaqueToken(key)}
    and (code_challenge is null or code_challenge = ${challenge}) and revoked_at is null and expires_at > ${now}
    and exists (select 1 from service_account_runs r where r.id = ${runId} and r.approved_at is null
      and r.revoked_at is null and r.branch_id is not null and r.expires_at > ${now})`
  return result.rowCount > 0
}

export async function approveGroupRun(tx: DbClient, owner: string, run: ServiceGroupRun, selection: Static<typeof ServiceGroupApproveSchema>) {
  // Every challenge is single-assignment. Match the operator's entire reviewed
  // roster, including member IDs, before authorizing any exchange.
  const expected = new Map(selection.members.map(m => [m.accountId, m.challenge]))
  if (selection.members.length !== run.members.length || run.members.some(m => expected.get(m.accountId) !== m.challenge)) return false
  const now = new Date().toISOString()
  const result = await tx`update service_account_runs set approved_at = ${now}
    where id = ${run.id} and approved_at is null and revoked_at is null and branch_id is not null and expires_at > ${now}
    and group_id in (select id from service_account_groups where owner_id = ${owner})`
  if (!result.rowCount) return false
  await tx`update service_accounts set enrollment_key_hash = null where group_run_id = ${run.id}`
  for (const member of run.members) {
    await createAuditEvent(tx, { actorUserId: owner, action: 'service_account.authorized', targetType: 'service_account',
      targetId: member.accountId, metadata: { runId: run.id } })
  }
  return true
}

export async function pollMember(db: DbClient, accountId: string, verifier: string) {
  const challenge = await hashOpaqueToken(verifier)
  return db.transaction(async tx => {
    const now = new Date().toISOString()
    const { rows } = await tx<{ approved_at: string | null; owner_id: string }>`
      select r.approved_at, a.owner_id from service_accounts a join service_account_runs r on r.id = a.group_run_id
      where a.id = ${accountId} and a.code_challenge = ${challenge} and a.revoked_at is null and a.expires_at > ${now}
      and r.revoked_at is null and r.branch_id is not null and r.expires_at > ${now}`
    if (!rows[0]) return null
    const sponsor = await findUserById(tx, rows[0].owner_id)
    if (sponsor?.status !== 'active' || !sponsor.capabilities.includes('ai.providers.manage')) return null
    if (!rows[0].approved_at) return { pending: true } as const
    const token = generateOpaqueToken('icli_at_')
    const result = await tx`update service_accounts set token_hash = ${await hashOpaqueToken(token)}, code_challenge = null
      where id = ${accountId} and code_challenge = ${challenge} and token_hash is null and revoked_at is null and expires_at > ${now}
      and exists (select 1 from service_account_runs r where r.id = service_accounts.group_run_id and r.approved_at is not null
        and r.revoked_at is null and r.branch_id is not null and r.expires_at > ${now})`
    return result.rowCount ? { token } : null
  })
}

export async function revokeGroupRun(tx: DbClient, owner: string, id: string) {
  const now = new Date().toISOString()
  const result = await tx`update service_account_runs set revoked_at = ${now} where id = ${id} and revoked_at is null
    and group_id in (select id from service_account_groups where owner_id = ${owner})`
  if (!result.rowCount) return false
  const members = await tx<{ id: string }>`update service_accounts set revoked_at = ${now}, token_hash = null,
    code_challenge = null, enrollment_key_hash = null where group_run_id = ${id} returning id`
  for (const member of members.rows) {
    await createAuditEvent(tx, { actorUserId: owner, action: 'service_account.revoked', targetType: 'service_account',
      targetId: member.id, metadata: { runId: id } })
  }
  return true
}
