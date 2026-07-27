/**
 * Visitor-auth HTTP endpoints — `/api/visitor/*`.
 *
 * `handleVisitorRoutes` owns the entire `/api/visitor/` namespace: CSRF
 * gating, dispatch, and a terminal 404 for any unknown sub-path (so an
 * unknown `/api/visitor/whatever` never falls through to the public route
 * renderer). The visitor namespace is intentionally isolated from the admin
 * auth surface (`/admin/api/cms/*`) — different cookie, different tables,
 * different code (D3 import whitelist).
 *
 * Phase-1 endpoints (full):  POST /register, POST /login, POST /logout,
 *                            GET /me, PATCH /me.
 * Phase-2 endpoints (full):  POST /forgot, POST /reset, DELETE /me.
 *
 * The parameterized gate endpoint lives at `/_instatic/gate/<nodeId>` and is
 * owned by the gate renderer — there is intentionally no `/api/visitor/gate/*`
 * route here (PRD §4.8 / D11).
 *
 * Login mirrors `server/handlers/cms/auth.ts` closely: per-IP then per-
 * (ip,email) rate limits, constant-time dummy-hash verify on the no-user
 * branch (so email enumeration via timing is impossible), per-account
 * lockout checked AFTER the constant-time verify, login-attempt log via
 * `recordVisitorLoginAttempt`, plus `visitor.*` audit events emitted from
 * each auth outcome (register/login/logout/reset/delete) so member sign-in
 * activity is visible in the admin audit feed.
 *
 * Audit note: every visitor event uses `actorUserId: null` +
 * `targetType: 'visitor_user'`. The `actor_user_id` column FK-references the
 * admin `users(id)` table, so it cannot hold a visitor id (visitors live in
 * `visitor_users`). The visitor's identity is carried in `target_id`
 * (free-text, no FK) + `metadata.email`.
 */
import type { DbClient } from '../db/client'
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  sessionExpiry,
  verifyPassword,
} from '../auth/tokens'
import { evaluateFailedAttempt, evaluateLockState } from '../auth/lockout'
import { clientIp, isStateChangingMethod, originAllowed } from '../auth/security'
import { jsonResponse, readValidatedBody, setCookieHeader } from '../http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { createAuditEvent } from '../repositories/audit'
import { requestAuditContext } from '../handlers/cms/shared'
import { nanoid } from 'nanoid'
import {
  VISITOR_PASSWORD_MIN,
  type VisitorLoginAttemptResult,
  type VisitorUser,
} from './types'
import {
  visitorForgotPerEmailRateLimit,
  visitorForgotPerIpRateLimit,
  visitorLoginPerIpRateLimit,
  visitorLoginRateLimit,
  visitorRegisterPerIpRateLimit,
} from './rateLimits'
import { getVisitorAuthConfig } from './config'
import { getEmailTransport } from '../email/transport'
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  createVisitorSession,
  createVisitorUser,
  findValidPasswordResetToken,
  findVisitorUserByEmailNormalized,
  findVisitorUserById,
  hardDeleteVisitorUser,
  markVisitorUserLoggedIn,
  recordVisitorFailedLogin,
  recordVisitorLoginAttempt,
  revokeAllVisitorSessionsForUser,
  revokeVisitorSessionByHash,
  updateVisitorUserDisplayName,
  updateVisitorUserPassword,
} from './repositories'
import { findVisitorRoleById, findVisitorRoleByName } from './roles'
import { resolveLoginRedirect } from './redirect'
import {
  clearVisitorSessionCookie,
  invalidateVisitorSessionCache,
  validateVisitorSession,
  visitorSessionCookie,
} from './sessions'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A fixed argon2id hash, computed once per process. Used by the login
 * handler as the verification target when the supplied email doesn't match
 * any visitor user — keeping the response time constant prevents an attacker
 * from learning which emails are registered via timing analysis. The hashed
 * plaintext is not a real password and never grants access.
 *
 * Local to this module (mirrors `getDummyPasswordHash` in
 * `server/handlers/cms/session.ts`, but isolated so the visitor system owns
 * its own instance — the admin and visitor surfaces do not share state).
 */
const dummyVisitorPasswordHashCache: Promise<string> = hashPassword(
  'not-a-real-visitor-account-placeholder',
)
function getDummyVisitorPasswordHash(): Promise<string> {
  return dummyVisitorPasswordHashCache
}

/** 429 envelope — body carries `retryAfterMs` (the runtime maps it to copy). */
function rateLimitedResponse(retryAfterMs: number): Response {
  return jsonResponse({ error: 'rate_limited', retryAfterMs }, { status: 429 })
}

/** 423 envelope — body carries `retryAfterMs`. */
function accountLockedResponse(retryAfterMs: number): Response {
  return jsonResponse({ error: 'account_locked', retryAfterMs }, { status: 423 })
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Basic email shape check — full validation is the email service's job. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/** The public profile shape returned by /register, /login, /me, PATCH /me. */
interface VisitorProfile {
  id: string
  email: string
  displayName: string
  role: string
  capabilities: string[]
}

async function profileFor(db: DbClient, user: VisitorUser): Promise<VisitorProfile> {
  const role = await findVisitorRoleById(db, user.roleId)
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: role?.name ?? user.roleId,
    capabilities: role?.capabilities ?? [],
  }
}

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------

const RegisterBodySchema = Type.Object({
  email: Type.String({ maxLength: 254 }),
  password: Type.String(),
  displayName: Type.Optional(Type.String({ maxLength: 200 })),
})

async function handleRegister(req: Request, db: DbClient): Promise<Response> {
  const body = await readValidatedBody(req, RegisterBodySchema)
  if (!body) return jsonResponse({ error: 'invalid_request' }, { status: 400 })

  const email = normalizeEmail(body.email)
  if (!email || email.length > 254 || !looksLikeEmail(email)) {
    return jsonResponse({ error: 'invalid_email' }, { status: 422 })
  }
  const password = body.password ?? ''
  if (password.length < VISITOR_PASSWORD_MIN) {
    return jsonResponse(
      { error: 'invalid_password', details: { password: `Password must be at least ${VISITOR_PASSWORD_MIN} characters.` } },
      { status: 422 },
    )
  }
  const displayName = (body.displayName ?? '').trim().slice(0, 200)

  const config = await getVisitorAuthConfig(db)
  if (!config.enabled) {
    return jsonResponse({ error: 'visitor_auth_disabled' }, { status: 403 })
  }
  if (!config.registrationOpen) {
    return jsonResponse({ error: 'registration_closed' }, { status: 403 })
  }

  const ip = clientIp(req)
  if (ip) {
    const decision = visitorRegisterPerIpRateLimit.consume(ip)
    if (!decision.ok) return rateLimitedResponse(decision.retryAfterMs)
  }

  const existing = await findVisitorUserByEmailNormalized(db, email)
  if (existing) return jsonResponse({ error: 'email_taken' }, { status: 409 })

  // Resolve the default role by name; fall back to the seeded 'member' role
  // id if the configured name doesn't match a row (defensive against a
  // hand-edited config.default_role).
  const defaultRoleName = config.defaultRole || 'member'
  let role = await findVisitorRoleByName(db, defaultRoleName)
  if (!role) role = await findVisitorRoleByName(db, 'member')
  if (!role) {
    // The migration seeds 'member' and 'admin' system rows; reaching here
    // means the install hasn't run the visitor migration. Surface it
    // clearly rather than crashing on a FK violation below.
    return jsonResponse({ error: 'visitor_auth_not_initialized' }, { status: 503 })
  }

  const passwordHash = await hashPassword(password)
  const user = await createVisitorUser(db, {
    id: nanoid(),
    email,
    emailNormalized: email,
    passwordHash,
    displayName,
    roleId: role.id,
  })

  // Self-registration: there is no authenticated actor, so actorUserId is
  // null. The visitor's identity rides in targetId (free-text) + metadata.
  await createAuditEvent(db, {
    actorUserId: null,
    action: 'visitor.register',
    targetType: 'visitor_user',
    targetId: user.id,
    metadata: { email },
    ...requestAuditContext(req),
  })

  return jsonResponse(await profileFor(db, user), { status: 201 })
}

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

const LoginBodySchema = Type.Object({
  email: Type.String({ maxLength: 254 }),
  password: Type.String(),
})

async function handleLogin(req: Request, db: DbClient): Promise<Response> {
  const config = await getVisitorAuthConfig(db)
  if (!config.enabled) {
    return jsonResponse({ error: 'visitor_auth_disabled' }, { status: 403 })
  }

  const body = await readValidatedBody(req, LoginBodySchema)
  if (!body) return jsonResponse({ error: 'invalid_request' }, { status: 400 })
  const email = normalizeEmail(body.email)
  const password = body.password ?? ''
  const ip = clientIp(req)
  const userAgent = req.headers.get('user-agent')

  // Layer 1 — per-IP rate limit. Blanket cap so one attacker IP cannot grind
  // through many visitor accounts. Skipped when no IP is surfaced; the
  // per-(ip,email) limiter still applies.
  if (ip) {
    const ipDecision = visitorLoginPerIpRateLimit.consume(ip)
    if (!ipDecision.ok) {
      await recordVisitorLoginAttempt(db, {
        emailNormalized: email || null,
        ipAddress: ip,
        userAgent,
        userId: null,
        result: 'rate_limited',
      })
      return rateLimitedResponse(ipDecision.retryAfterMs)
    }
  }

  // Layer 2 — per-(ip,email) tuple. Defends a single account across many IPs.
  const rateLimitKey = `${ip ?? 'unknown'}|${email}`
  const tupleDecision = visitorLoginRateLimit.consume(rateLimitKey)
  if (!tupleDecision.ok) {
    await recordVisitorLoginAttempt(db, {
      emailNormalized: email || null,
      ipAddress: ip,
      userAgent,
      userId: null,
      result: 'rate_limited',
    })
    return rateLimitedResponse(tupleDecision.retryAfterMs)
  }

  // Constant-time path: ALWAYS run argon2id verify, even when the email
  // doesn't match a user. Without this, "user not found" returns in ~5ms
  // while "user found, wrong password" takes ~100ms — a timing oracle for
  // email enumeration. Verify against a fixed dummy hash on the no-user
  // branch; the result is always false but the latency profile matches.
  const user = await findVisitorUserByEmailNormalized(db, email)
  const verifiedHash = user?.passwordHash ?? (await getDummyVisitorPasswordHash())
  const passwordOk = await verifyPassword(password, verifiedHash)

  // Layer 3 — per-account lockout. Checked AFTER the constant-time verify so
  // the locked-vs-not-locked latency profile doesn't leak whether the email
  // exists.
  if (user) {
    const lockState = evaluateLockState(user.lockedUntil)
    if (lockState.locked) {
      await recordVisitorLoginAttempt(db, {
        emailNormalized: email || null,
        ipAddress: ip,
        userAgent,
        userId: user.id,
        result: 'locked',
      })
      await createAuditEvent(db, {
        actorUserId: null,
        action: 'visitor.login.locked',
        targetType: 'visitor_user',
        targetId: user.id,
        metadata: { email, lockedUntil: user.lockedUntil ?? '' },
        ...requestAuditContext(req),
      })
      return accountLockedResponse(lockState.retryAfterMs)
    }
  }

  if (!user || user.status !== 'active' || !passwordOk) {
    const failureReason: VisitorLoginAttemptResult = !user
      ? 'no_user'
      : user.status !== 'active'
        ? 'account_disabled'
        : 'bad_password'

    await recordVisitorLoginAttempt(db, {
      emailNormalized: email || null,
      ipAddress: ip,
      userAgent,
      userId: user?.id ?? null,
      result: failureReason,
    })

    // Bump the per-account counter ONLY for the bad-password-against-active
    // branch. A "no such user" attempt is bound to the IP layer + the
    // login_attempts log; a suspended account doesn't need its counter raised.
    let lockedUntilIso: string | null = null
    if (user && user.status === 'active' && failureReason === 'bad_password') {
      const lockout = evaluateFailedAttempt(user.failedLoginCount)
      await recordVisitorFailedLogin(db, user.id, lockout.lockedUntil)
      if (lockout.triggered && lockout.lockedUntil) {
        lockedUntilIso = lockout.lockedUntil.toISOString()
      }
    }

    await createAuditEvent(db, {
      actorUserId: null,
      action: 'visitor.login.failure',
      targetType: 'visitor_user',
      targetId: user?.id ?? null,
      metadata: { email, reason: failureReason },
      ...requestAuditContext(req),
    })

    if (lockedUntilIso) {
      return accountLockedResponse(Math.max(0, Date.parse(lockedUntilIso) - Date.now()))
    }
    return jsonResponse({ error: 'invalid_credentials' }, { status: 401 })
  }

  // Success — mint session, record it, clear the rate buckets.
  visitorLoginRateLimit.reset(rateLimitKey)
  if (ip) visitorLoginPerIpRateLimit.reset(ip)

  const token = createSessionToken()
  const expiresAt = sessionExpiry()
  await createVisitorSession(db, {
    idHash: await hashSessionToken(token),
    userId: user.id,
    expiresAt,
    ipAddress: ip,
    userAgent,
  })
  await recordVisitorLoginAttempt(db, {
    emailNormalized: email || null,
    ipAddress: ip,
    userAgent,
    userId: user.id,
    result: 'success',
  })
  await markVisitorUserLoggedIn(db, user.id)

  await createAuditEvent(db, {
    actorUserId: null,
    action: 'visitor.login.success',
    targetType: 'visitor_user',
    targetId: user.id,
    metadata: { email },
    ...requestAuditContext(req),
  })

  const profile = await profileFor(db, user)
  // D15: resolve the post-login landing path server-side (explicit redirect →
  // primary-group landing → default) and hand it to the browser runtime via
  // the response body so the runtime stays dumb.
  const redirect = await resolveLoginRedirect(db, req, user.id, config.defaultLandingPath)
  return setCookieHeader(
    jsonResponse({ ...profile, redirect }, { status: 200 }),
    visitorSessionCookie(req, token, expiresAt),
  )
}

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------

async function handleLogout(req: Request, db: DbClient): Promise<Response> {
  const session = await validateVisitorSession(db, req)
  if (!session) return jsonResponse({ error: 'unauthorized' }, { status: 401 })
  await revokeVisitorSessionByHash(db, session.idHash)
  invalidateVisitorSessionCache(session.idHash)
  await createAuditEvent(db, {
    actorUserId: null,
    action: 'visitor.logout',
    targetType: 'visitor_user',
    targetId: session.userId,
    ...requestAuditContext(req),
  })
  // PRD D9: 204 no body. The Set-Cookie must still ride on the response.
  return setCookieHeader(new Response(null, { status: 204 }), clearVisitorSessionCookie(req))
}

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

async function handleMe(req: Request, db: DbClient): Promise<Response> {
  const session = await validateVisitorSession(db, req)
  if (!session) return jsonResponse({ error: 'unauthorized' }, { status: 401 })
  const user = await findVisitorUserById(db, session.userId)
  if (!user) return jsonResponse({ error: 'unauthorized' }, { status: 401 })
  return jsonResponse(await profileFor(db, user), { status: 200 })
}

// ---------------------------------------------------------------------------
// PATCH /me
// ---------------------------------------------------------------------------

const PatchMeBodySchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ maxLength: 200 })),
    email: Type.Optional(Type.String()),
  },
  // Reject unknown keys defensively — Phase 1 only accepts displayName.
  { additionalProperties: false },
)

async function handlePatchMe(req: Request, db: DbClient): Promise<Response> {
  const session = await validateVisitorSession(db, req)
  if (!session) return jsonResponse({ error: 'unauthorized' }, { status: 401 })
  const body = await readValidatedBody(req, PatchMeBodySchema)
  if (!body) return jsonResponse({ error: 'invalid_request' }, { status: 400 })

  // Email change is deferred to Phase 2 — surface it explicitly so the
  // client knows it wasn't ignored.
  if (body.email !== undefined) {
    return jsonResponse({ error: 'email_change_not_supported' }, { status: 422 })
  }

  const current = await findVisitorUserById(db, session.userId)
  if (!current) return jsonResponse({ error: 'unauthorized' }, { status: 401 })

  const displayName =
    body.displayName === undefined ? current.displayName : body.displayName.trim().slice(0, 200)
  const updated = await updateVisitorUserDisplayName(db, session.userId, displayName)
  if (!updated) return jsonResponse({ error: 'unauthorized' }, { status: 401 })
  return jsonResponse(await profileFor(db, updated), { status: 200 })
}

// ---------------------------------------------------------------------------
// POST /forgot  (V7 — password reset request)
// ---------------------------------------------------------------------------

const ForgotBodySchema = Type.Object({
  email: Type.String({ maxLength: 254 }),
})

/**
 * Request a password reset. ALWAYS returns 200 `{ ok: true }` — whether or
 * not the email matches a visitor — so the endpoint cannot be used for email
 * enumeration (PRD §7). On a real match a one-shot reset token is minted and
 * the reset link is handed to the email transport; on no match nothing is
 * sent. Transport failures are logged but never surfaced to the caller (a
 * delivery outage must not leak that the account exists).
 */
async function handleForgot(req: Request, db: DbClient): Promise<Response> {
  const body = await readValidatedBody(req, ForgotBodySchema)
  if (!body) return jsonResponse({ error: 'invalid_request' }, { status: 400 })

  const email = normalizeEmail(body.email)

  // Layer 1 — per-IP. A single attacker IP cannot flood reset requests
  // (the primary email-enumeration / annoyance vector). Skipped when no IP
  // is surfaced; the per-email limiter still applies.
  const ip = clientIp(req)
  if (ip) {
    const ipDecision = visitorForgotPerIpRateLimit.consume(ip)
    if (!ipDecision.ok) return rateLimitedResponse(ipDecision.retryAfterMs)
  }

  // Layer 2 — per normalized email. Caps reset-mail volume to one address,
  // even across many IPs. Always consumed (even for unknown emails) so an
  // attacker cannot probe by observing whether the limiter tripped.
  const emailDecision = visitorForgotPerEmailRateLimit.consume(email || 'unknown')
  if (!emailDecision.ok) return rateLimitedResponse(emailDecision.retryAfterMs)

  const user = await findVisitorUserByEmailNormalized(db, email)
  if (user) {
    const rawToken = await createPasswordResetToken(db, user.id)
    const config = await getVisitorAuthConfig(db)
    const origin = new URL(req.url).origin
    const resetLink = `${origin}${config.loginPath}?reset=${encodeURIComponent(rawToken)}`
    try {
      await getEmailTransport().send({
        to: user.email,
        subject: 'Reset your password',
        text: resetLink,
        html: `<p>Reset your password: <a href="${resetLink}">${resetLink}</a></p>`,
      })
    } catch (err) {
      // Never reveal delivery failure — log and continue as if it succeeded.
      console.error('[visitor-auth] forgot-password transport error:', err)
    }
  }

  return jsonResponse({ ok: true }, { status: 200 })
}

// ---------------------------------------------------------------------------
// POST /reset  (V7 — consume reset token, set new password)
// ---------------------------------------------------------------------------

const ResetBodySchema = Type.Object({
  token: Type.String(),
  password: Type.String(),
})

/**
 * Consume a one-shot reset token and set a new password. The raw token is
 * hashed (SHA-256) before any DB lookup, so the raw value never touches the
 * query layer. A token is valid only when it exists, is unused, and has not
 * expired; `consumePasswordResetToken` performs the atomic one-shot consume
 * (a concurrent reset race resolves to exactly one winner). On success every
 * existing session for the user is revoked, forcing a fresh login.
 */
async function handleReset(req: Request, db: DbClient): Promise<Response> {
  const body = await readValidatedBody(req, ResetBodySchema)
  if (!body) return jsonResponse({ error: 'invalid_request' }, { status: 400 })

  const token = body.token ?? ''
  const password = body.password ?? ''
  if (password.length < VISITOR_PASSWORD_MIN) {
    return jsonResponse(
      { error: 'invalid_password', details: { password: `Password must be at least ${VISITOR_PASSWORD_MIN} characters.` } },
      { status: 422 },
    )
  }

  const tokenHash = await hashSessionToken(token)
  const resetToken = await findValidPasswordResetToken(db, tokenHash)
  if (!resetToken) {
    return jsonResponse({ error: 'invalid_or_expired_token' }, { status: 401 })
  }

  // Atomic one-shot consume — guards against a concurrent double-spend of
  // the same token (e.g. two tabs submitting at once). rowCount 0 means
  // another caller already consumed it.
  const consumed = await consumePasswordResetToken(db, tokenHash)
  if (!consumed) {
    return jsonResponse({ error: 'invalid_or_expired_token' }, { status: 401 })
  }

  const newPasswordHash = await hashPassword(password)
  await updateVisitorUserPassword(db, resetToken.userId, newPasswordHash)
  // Force re-login everywhere — every prior session (including the one this
  // request arrived on, if any) is dead.
  await revokeAllVisitorSessionsForUser(db, resetToken.userId)

  await createAuditEvent(db, {
    actorUserId: null,
    action: 'visitor.password.reset',
    targetType: 'visitor_user',
    targetId: resetToken.userId,
    ...requestAuditContext(req),
  })

  return jsonResponse({ ok: true }, { status: 200 })
}

// ---------------------------------------------------------------------------
// DELETE /me  (V8 — GDPR self-service account deletion)
// ---------------------------------------------------------------------------

const DeleteMeBodySchema = Type.Object({
  password: Type.String(),
})

/**
 * Delete the caller's own visitor account + PII, gated on a fresh
 * re-verification of their current password (so a stolen session cookie
 * alone cannot delete the account). On success every session is revoked,
 * PII is anonymized in place, and the cookie is cleared. The row is kept
 * (soft-delete) for FK/audit integrity — see `hardDeleteVisitorUser`.
 */
async function handleDeleteMe(req: Request, db: DbClient): Promise<Response> {
  const session = await validateVisitorSession(db, req)
  if (!session) return jsonResponse({ error: 'unauthorized' }, { status: 401 })

  const body = await readValidatedBody(req, DeleteMeBodySchema)
  if (!body) return jsonResponse({ error: 'invalid_request' }, { status: 400 })

  const user = await findVisitorUserById(db, session.userId)
  if (!user) return jsonResponse({ error: 'unauthorized' }, { status: 401 })

  // Re-verify the password — the session alone is not enough authority to
  // destroy the account. A wrong password is a flat 401 (no retry guidance;
  // the client treats it the same as a generic auth failure).
  const passwordOk = await verifyPassword(body.password ?? '', user.passwordHash)
  if (!passwordOk) {
    return jsonResponse({ error: 'invalid_password' }, { status: 401 })
  }

  // Tear down every session first (including this one), then wipe the row.
  await revokeAllVisitorSessionsForUser(db, user.id)
  await hardDeleteVisitorUser(db, user.id)
  invalidateVisitorSessionCache(session.idHash)

  await createAuditEvent(db, {
    actorUserId: null,
    action: 'visitor.account.deleted',
    targetType: 'visitor_user',
    targetId: user.id,
    metadata: { email: user.email },
    ...requestAuditContext(req),
  })

  return setCookieHeader(
    jsonResponse({ ok: true }, { status: 200 }),
    clearVisitorSessionCookie(req),
  )
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type RouteHandler = (req: Request, db: DbClient) => Promise<Response>

interface Route {
  method: string
  /** Exact-match pathname. Parameterized visitor paths live under `/_instatic/`. */
  pattern: string
  handler: RouteHandler
}

const routes: readonly Route[] = [
  { method: 'POST', pattern: '/api/visitor/register', handler: handleRegister },
  { method: 'POST', pattern: '/api/visitor/login', handler: handleLogin },
  { method: 'POST', pattern: '/api/visitor/logout', handler: handleLogout },
  { method: 'GET', pattern: '/api/visitor/me', handler: handleMe },
  { method: 'PATCH', pattern: '/api/visitor/me', handler: handlePatchMe },
  { method: 'DELETE', pattern: '/api/visitor/me', handler: handleDeleteMe },
  { method: 'POST', pattern: '/api/visitor/forgot', handler: handleForgot },
  { method: 'POST', pattern: '/api/visitor/reset', handler: handleReset },
]

/**
 * Dispatch every `/api/visitor/*` request. CSRF gating runs first for
 * state-changing methods; a path-matched / wrong-method request resolves to
 * 405; any unknown path under the prefix resolves to a terminal 404 so it
 * never falls through to the public route renderer.
 */
export async function handleVisitorRoutes(req: Request, db: DbClient): Promise<Response> {
  if (isStateChangingMethod(req.method) && !originAllowed(req)) {
    return jsonResponse({ error: 'forbidden_origin' }, { status: 403 })
  }

  const { pathname } = new URL(req.url)
  let pathMatched = false
  for (const route of routes) {
    if (pathname !== route.pattern) continue
    pathMatched = true
    if (req.method !== route.method) continue
    try {
      return await route.handler(req, db)
    } catch (err) {
      console.error('[visitor-auth] handler error:', err)
      return jsonResponse(
        { error: getErrorMessage(err, 'Internal server error') },
        { status: 500 },
      )
    }
  }

  if (pathMatched) return jsonResponse({ error: 'method_not_allowed' }, { status: 405 })
  return jsonResponse({ error: 'not_found' }, { status: 404 })
}
