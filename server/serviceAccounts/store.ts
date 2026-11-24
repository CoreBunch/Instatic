import { randomUUID } from 'node:crypto'
import { ServiceCapabilitySchema, type ServiceAccount, type ServiceAccountInputSchema } from '@core/serviceAccounts'
import { filterArray, type Static } from '@core/utils/typeboxHelpers'
import { createUser, findUserById, type AuthUser } from '../repositories/users'
import type { DbClient } from '../db/client'
import { generateOpaqueToken, hashOpaqueToken } from '../oauth/secrets'

interface AccountRow {
  id: string
  owner_id: string
  label: string
  capabilities_json: unknown
  expires_at: string
  revoked_at: string | null
  connected: number
}

function view(row: AccountRow): ServiceAccount {
  return { id: row.id, label: row.label, capabilities: filterArray(ServiceCapabilitySchema, row.capabilities_json),
    expiresAt: row.expires_at, revoked: !!row.revoked_at, expired: Date.parse(row.expires_at) <= Date.now(), connected: Boolean(row.connected) }
}

export async function listAccounts(db: DbClient, owner: string) {
  const { rows } = await db<AccountRow>`
    select id, owner_id, label, capabilities_json, expires_at, revoked_at,
      case when token_hash is null then 0 else 1 end as connected
    from service_accounts where owner_id = ${owner} order by expires_at desc, id`
  return rows.map(view)
}

export async function createAccount(db: DbClient, owner: string, input: Static<typeof ServiceAccountInputSchema>) {
  const id = 'svc_' + randomUUID()
  const label = input.label.trim()
  const expiry = new Date(Date.now() + input.ttlHours * 3600000).toISOString()
  // Suspended login identity supplies FK-backed attribution and ownership. Only the
  // connector resolver below can authorize this actor.
  await createUser(db, { id, email: id + '@service.invalid', displayName: label, roleId: 'member',
    passwordHash: '!', status: 'suspended' })
  await db`insert into service_accounts (id, owner_id, label, capabilities_json, expires_at)
    values (${id}, ${owner}, ${label}, ${input.capabilities}, ${expiry})`
  return id
}

export async function renewExpiredAccount(db: DbClient, id: string, owner: string, ttlHours: number) {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlHours * 3600000).toISOString()
  // Keep the paired credential. An outstanding pairing code belongs to the old access window.
  const result = await db`update service_accounts set expires_at = ${expiresAt},
    code_hash = null, code_challenge = null, code_expires_at = null
    where id = ${id} and owner_id = ${owner} and revoked_at is null and expires_at <= ${now.toISOString()}`
  return result.rowCount ? { expiresAt } : null
}

export async function revokeAccount(db: DbClient, id: string, owner: string) {
  const result = await db`update service_accounts set revoked_at = ${new Date().toISOString()}, token_hash = null,
    code_hash = null, code_challenge = null, code_expires_at = null
    where id = ${id} and owner_id = ${owner} and revoked_at is null`
  return result.rowCount > 0
}

export async function issueCode(db: DbClient, id: string, owner: string, challenge: string) {
  const code = generateOpaqueToken('icli_code_')
  const now = new Date()
  const result = await db`update service_accounts set code_hash = ${await hashOpaqueToken(code)},
    code_challenge = ${challenge},
    code_expires_at = ${new Date(now.getTime() + 60000).toISOString()}
    where id = ${id} and owner_id = ${owner} and revoked_at is null and expires_at > ${now.toISOString()}`
  return result.rowCount ? code : null
}

export async function exchangeCode(db: DbClient, id: string, code: string, verifier: string) {
  const token = generateOpaqueToken('icli_at_')
  const now = new Date().toISOString()
  return db.transaction(async tx => {
    const codeHash = await hashOpaqueToken(code)
    const { rows } = await tx<{ owner_id: string }>`select owner_id from service_accounts where id = ${id} and code_hash = ${codeHash}`
    const sponsor = rows[0] && await findUserById(tx, rows[0].owner_id)
    if (sponsor?.status !== 'active' || !sponsor.capabilities.includes('ai.providers.manage')) return null
    const result = await tx`update service_accounts set token_hash = ${await hashOpaqueToken(token)},
      code_hash = null, code_challenge = null, code_expires_at = null where id = ${id}
      and code_hash = ${codeHash} and code_challenge = ${await hashOpaqueToken(verifier)}
      and code_expires_at > ${now} and expires_at > ${now} and revoked_at is null`
    return result.rowCount ? token : null
  })
}

export async function resolveServiceActor(db: DbClient, token: string): Promise<{ user: AuthUser; expiresAt: string } | null> {
  const { rows } = await db<AccountRow>`select id, owner_id, label, capabilities_json, expires_at, revoked_at
    from service_accounts where token_hash = ${await hashOpaqueToken(token)} and revoked_at is null
    and expires_at > ${new Date().toISOString()}`
  const account = rows[0]
  if (!account) return null
  const owner = await findUserById(db, account.owner_id)
  if (owner?.status !== 'active' || !owner.capabilities.includes('ai.providers.manage')) return null
  const actor = await findUserById(db, account.id)
  if (!actor || actor.status !== 'suspended') return null
  const capabilities = filterArray(ServiceCapabilitySchema, account.capabilities_json).filter(c => owner.capabilities.includes(c))
  return {
    user: { ...actor, capabilities, role: { ...actor.role, capabilities } },
    expiresAt: account.expires_at,
  }
}
