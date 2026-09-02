/**
 * Self-targeted user mutations — endpoints any authenticated user can call
 * to change their own profile data without needing `users.manage`.
 *
 *   PATCH  /admin/api/cms/me        — update display name and email
 *   POST   /admin/api/cms/me/avatar — upload a new avatar image
 *   DELETE /admin/api/cms/me/avatar — clear the avatar, falling back to the
 *                                     Gravatar identicon served by the client
 *
 * `GET /admin/api/cms/me` lives in `./auth.ts` because it shares the session
 * helpers with login/logout. The avatar endpoints land here so the file
 * stays focused on self-mutation flows (display-name edit, avatar, password
 * change all slot in next to each other).
 *
 * Avatars are stored as ordinary `media_assets` rows + an `avatar_media_id`
 * pointer on the user. We deliberately leave the old media row in the
 * library when the user replaces or clears their avatar — the bytes already
 * cost storage and tracking ownership-for-cascade-delete is out of scope
 * for this surface. Operators can prune via the media library.
 */
import type { DbClient } from '../../db/client'
import { getSessionHash, requireAuthenticatedUser, requireStepUp } from '../../auth/authz'
import { hashPassword, verifyPassword } from '../../auth/tokens'
import { markSessionMfaPassed } from '../../auth/sessions'
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpProvisioningUri,
  verifyTotpCode,
} from '../../auth/mfa'
import { totpSecretErrorResponse } from '../../auth/totpSecrets'
import {
  disableUserTotpMfa,
  enableUserTotpMfa,
  findUserByEmail,
  replaceUserRecoveryCodeHashes,
  setUserAvatarMediaId,
  updateUser,
  updateUserStepUpPolicy,
  updateUserPasswordHash,
} from '../../repositories/users'
import { revokeAllOtherSessions } from '../../repositories/sessions'
import { createAuditEvent } from '../../repositories/audit'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import {
  CMS_API_PREFIX,
  mutationErrorResponse,
  requestAuditContext,
  type CmsHandlerOptions,
} from './shared'
import {
  IMAGE_MIMES,
  acceptUploadedMedia,
  readUploadedFile,
} from './mediaUpload'
import { Type } from '@core/utils/typeboxHelpers'
import { isValidEmail } from '@core/utils/email'
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT_MESSAGE } from '@core/utils/passwordPolicy'

/**
 * Avatars are capped at 5 MB — full-resolution camera output is wildly
 * oversized for a 96×96 portrait and the library cap (50 MB) is a footgun
 * here. 5 MB still comfortably accommodates a 4000×4000 PNG.
 */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

const ChangePasswordBodySchema = Type.Object({
  newPassword: Type.String({ minLength: MIN_PASSWORD_LENGTH }),
})

const UpdateProfileBodySchema = Type.Object({
  displayName: Type.String({ maxLength: 160 }),
  email: Type.String({ minLength: 3, maxLength: 320 }),
})

const EnableTotpBodySchema = Type.Object({
  secret: Type.String({ minLength: 16 }),
  code: Type.String({ minLength: 6 }),
})

const StepUpAuthModeSchema = Type.Union([
  Type.Literal('required'),
  Type.Literal('disabled'),
])
const StepUpWindowMinutesSchema = Type.Union([
  Type.Literal(5),
  Type.Literal(15),
  Type.Literal(30),
  Type.Literal(60),
])
const UpdateStepUpPolicyBodySchema = Type.Object({
  mode: StepUpAuthModeSchema,
  windowMinutes: StepUpWindowMinutesSchema,
})

function newRecoveryCodeSet(): { codes: string[]; hashes: string[] } {
  const codes = generateRecoveryCodes()
  return {
    codes,
    hashes: codes.map(hashRecoveryCode),
  }
}

export async function handleMeRoutes(
  req: Request,
  db: DbClient,
  _options: CmsHandlerOptions,
): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === `${CMS_API_PREFIX}/me`) {
    if (req.method !== 'PATCH') return null
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
    const body = await readValidatedBody(req, UpdateProfileBodySchema)
    if (!body) return badRequest('Invalid profile payload')

    const email = body.email.trim()
    if (!isValidEmail(email)) return badRequest('Invalid email address')
    const existing = await findUserByEmail(db, email)
    if (existing && existing.id !== user.id) {
      return badRequest('Email is already in use')
    }

    try {
      const updated = await updateUser(db, user.id, {
        displayName: body.displayName,
        email,
      })
      if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })

      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'user.update',
        targetType: 'user',
        targetId: user.id,
        metadata: {
          profileChanged: true,
          displayNameChanged: updated.displayName !== user.displayName,
          emailChanged: updated.email !== user.email,
        },
        ...requestAuditContext(req),
      })
      return jsonResponse({ user: updated })
    } catch (err) {
      return mutationErrorResponse(err)
    }
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/password`) {
    if (req.method !== 'PATCH') return methodNotAllowed()
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
    const body = await readValidatedBody(req, ChangePasswordBodySchema)
    if (!body) return badRequest(PASSWORD_TOO_SHORT_MESSAGE)
    if (await verifyPassword(body.newPassword, user.passwordHash)) {
      return badRequest('Choose a different password')
    }

    const updated = await updateUserPasswordHash(db, user.id, await hashPassword(body.newPassword))
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })
    const currentSessionHash = await getSessionHash(req)
    const revokedSessions = await revokeAllOtherSessions(db, user.id, currentSessionHash)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { passwordChanged: true, revokedSessions },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated, revokedSessions })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/mfa/totp/start`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
    const secret = generateTotpSecret()
    return jsonResponse({
      secret,
      otpauthUrl: totpProvisioningUri({
        issuer: 'Instatic',
        accountName: user.email,
        secret,
      }),
    })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/mfa/totp/enable`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
    const body = await readValidatedBody(req, EnableTotpBodySchema)
    if (!body) return badRequest('Invalid MFA setup request')

    const codeOk = (() => {
      try {
        return verifyTotpCode(body.secret, body.code)
      } catch {
        return false
      }
    })()
    if (!codeOk) return badRequest('Invalid authentication code')

    const recovery = newRecoveryCodeSet()
    let updated: Awaited<ReturnType<typeof enableUserTotpMfa>>
    try {
      updated = await enableUserTotpMfa(db, user.id, {
        secret: body.secret,
        recoveryCodeHashes: recovery.hashes,
      })
    } catch (err) {
      const response = totpSecretErrorResponse(err)
      if (response) return response
      throw err
    }
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })

    const currentSessionHash = await getSessionHash(req)
    if (currentSessionHash) await markSessionMfaPassed(db, currentSessionHash)
    await revokeAllOtherSessions(db, user.id, currentSessionHash)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { mfaEnabled: true, recoveryCodesRegenerated: true },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated, recoveryCodes: recovery.codes })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/mfa/totp`) {
    if (req.method !== 'DELETE') return methodNotAllowed()
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
    const updated = await disableUserTotpMfa(db, user.id)
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { mfaEnabled: false },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/mfa/recovery-codes`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
    if (!user.mfaEnabled) return badRequest('Enable MFA before generating recovery codes')
    const recovery = newRecoveryCodeSet()
    const updated = await replaceUserRecoveryCodeHashes(db, user.id, recovery.hashes)
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { recoveryCodesRegenerated: true },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated, recoveryCodes: recovery.codes })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/security/step-up`) {
    if (req.method !== 'PATCH') return methodNotAllowed()
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user, { policy: 'always' })
    if (stepUp) return stepUp
    const body = await readValidatedBody(req, UpdateStepUpPolicyBodySchema)
    if (!body) return badRequest('Invalid step-up settings')
    const updated = await updateUserStepUpPolicy(db, user.id, {
      mode: body.mode,
      windowMinutes: body.windowMinutes,
    })
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: {
        stepUpAuthMode: updated.stepUpAuthMode,
        stepUpWindowMinutes: updated.stepUpWindowMinutes,
      },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated })
  }

  if (url.pathname !== `${CMS_API_PREFIX}/me/avatar`) return null

  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user

  if (req.method === 'POST') {
    const file = await readUploadedFile(req)
    if (!file) return badRequest('Missing file')

    const asset = await acceptUploadedMedia(db, {
      file,
      maxBytes: MAX_AVATAR_BYTES,
      allowedMimes: IMAGE_MIMES,
      role: 'avatar',
      uploadedByUserId: user.id,
      oversizedMessage: 'Avatar must be smaller than 5 MB',
      unsupportedMessage: 'Avatars must be a JPEG, PNG, GIF, or WebP image',
    })
    if (asset instanceof Response) return asset

    const updated = await setUserAvatarMediaId(db, user.id, asset.id)
    if (!updated) {
      // The user row vanished between auth and the update (e.g. concurrent
      // soft-delete). The uploaded asset stays in the media library — it's
      // already a first-class row and the caller can clean it up there.
      return jsonResponse({ error: 'User not found' }, { status: 404 })
    }

    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { avatarMediaId: asset.id },
      ...requestAuditContext(req),
    })

    return jsonResponse({ user: updated })
  }

  if (req.method === 'DELETE') {
    const updated = await setUserAvatarMediaId(db, user.id, null)
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })

    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { avatarMediaId: null },
      ...requestAuditContext(req),
    })

    return jsonResponse({ user: updated })
  }

  return methodNotAllowed()
}
