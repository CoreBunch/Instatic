import { nanoid } from 'nanoid'
import { nowIso } from '@core/utils/isoDate'
import type { DbClient } from '../db/client'
import { UserMutationError } from './users'

/** Reissue only an outstanding invitation for the same role. A normal account is never overwritten. */
export async function storeUserInvitation(db: DbClient, input: {
  email: string
  roleId: string
  passwordHash: string
  tokenHash: string
  expiresAt: Date
}): Promise<string> {
  const { rows } = await db<{ id: string }>`
    insert into users (id, email, email_normalized, display_name, role_id, status, password_hash,
                       invitation_hash, invitation_expires_at)
    values (${nanoid()}, ${input.email}, ${input.email.toLowerCase()}, '', ${input.roleId}, 'suspended',
            ${input.passwordHash}, ${input.tokenHash}, ${input.expiresAt})
    on conflict (email_normalized) where deleted_at is null do update
    set invitation_hash = excluded.invitation_hash, invitation_expires_at = excluded.invitation_expires_at,
        updated_at = ${nowIso()}
    where users.invitation_hash is not null and users.status = 'suspended' and users.role_id = excluded.role_id
    returning id
  `
  if (!rows[0]) throw new UserMutationError('This address already has an account or an invitation for a different role.', 409)
  return rows[0].id
}

export async function invitationIsCurrent(db: DbClient, tokenHash: string): Promise<boolean> {
  const { rows } = await db`select id from users where invitation_hash = ${tokenHash}
    and invitation_expires_at > ${nowIso()} and status = 'suspended' and deleted_at is null`
  return rows.length > 0
}

export async function activateInvitedUser(db: DbClient, tokenHash: string, passwordHash: string) {
  const now = nowIso()
  const { rows } = await db<{ id: string; email: string }>`
    update users set password_hash = ${passwordHash}, password_updated_at = ${now}, updated_at = ${now},
      invitation_hash = null, invitation_expires_at = null, status = 'active', failed_login_count = 0, locked_until = null
    where invitation_hash = ${tokenHash} and invitation_expires_at > ${now} and status = 'suspended' and deleted_at is null
    returning id, email
  `
  return rows[0]
}
