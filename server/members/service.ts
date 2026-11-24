/**
 * What a member can do: sign up, sign in and out, prove an email address,
 * recover and change a password, change an email, edit a profile, export and
 * delete their account.
 *
 * Each function takes validated plain input and returns a `MemberOutcome`.
 * None of them knows about HTTP: `handlers.ts` turns an outcome into a
 * redirect or JSON and sets or clears the cookie.
 *
 * Rules that hold across every flow:
 *
 *  - Answers never reveal whether an email address has an account. Sign-up,
 *    reset and sign-in-link requests answer `check_email` for everyone; a
 *    wrong sign-in is `invalid_credentials` whether the address exists or
 *    not, and always costs one password verification.
 *  - A password only becomes a member's password once the address is proven
 *    (see `signUp`).
 *  - Anything that changes how an account is reached revokes its other
 *    sessions and withdraws its outstanding links.
 */
import type { DbClient } from '../db/client'
import {
  MEMBER_EMAIL_MAX_LENGTH,
  MEMBER_PASSWORD_MAX_LENGTH,
  type CurrentMember,
  type MemberErrorCode,
  type MemberPagePaths,
  type MemberProfile,
  type MemberProfileField,
} from '@core/members'
import { listConnectedMemberApps } from '@core/loops'
import { MAIL_ADDRESS_PATTERN } from '@core/mail'
import { MIN_PASSWORD_LENGTH } from '@core/utils/passwordPolicy'
import { hashPassword, hashSessionToken, verifyPassword } from '../auth/tokens'
import { revokeAllMemberAppGrants } from './apps/store'
import { memberLimits } from './limits'
import { discardQueuedMailForMember } from '../mail/delivery'
import { emitMemberHook } from './hooks'
import { memberLinkPage, memberTokenLink, queueMemberMail } from './mail'
import { getMemberPagePaths, resolveMemberPagePaths } from './pages'
import {
  anonymizeMember,
  createMember,
  findMemberByEmail,
  findMemberById,
  getMemberSettings,
  listActiveMemberTags,
  listMemberEvents,
  markMemberLoggedIn,
  markMemberVerified,
  normalizeMemberEmail,
  recordMemberEvent,
  setMemberEmail,
  setMemberPasswordHash,
  setMemberProfile,
  toCurrentMember,
  type MemberEventContext,
  type MemberRecord,
} from './repository'
import {
  createMemberSession,
  listMemberSessions,
  revokeAllMemberSessions,
  revokeMemberSession,
  type SignedInMember,
} from './sessions'
import { consumeMemberToken, issueMemberToken, withdrawMemberTokens } from './tokens'

// ─── Shapes ────────────────────────────────────────────────────────────────

export interface MemberActionContext extends MemberEventContext {
  db: DbClient
  /** Origin for links in emails, or null when none can be trusted. */
  linkOrigin: string | null
  /** Can an email with a link be delivered at all right now? */
  mailAvailable: boolean
}

export type MemberSuccessCode =
  | 'check_email'
  | 'signed_in'
  | 'signed_out'
  | 'updated'
  | 'deleted'
  | 'app_approved'
  | 'app_refused'

export type MemberOutcome =
  | {
      ok: true
      code: MemberSuccessCode
      /** Start this session (set the cookie) or end the current one. */
      session?: { token: string; expiresAt: string } | 'clear'
      /** Remember the browser that signed up (see `signUp`). */
      signupNonce?: string
      member?: CurrentMember
      /**
       * Where a member who just signed in goes when neither the page they came
       * from (`?next=`) nor the form says: the owner's "after signing in" page.
       */
      landing?: string
      /**
       * An app sign-in was answered: the app's own address to send the browser
       * to, already checked against the addresses registered for that app.
       */
      appRedirect?: string
    }
  | { ok: false; code: MemberErrorCode; field?: string; retryAfterMs?: number }

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)
/** A passwordless member re-authenticates by having signed in this recently. */
const RECENT_SIGN_IN_MS = 15 * 60 * 1000

function fail(code: MemberErrorCode, field?: string): MemberOutcome {
  return field ? { ok: false, code, field } : { ok: false, code }
}

function limited(retryAfterMs: number): MemberOutcome {
  return { ok: false, code: 'rate_limited', retryAfterMs }
}

/**
 * May another email of this kind go to this address? Two windows: one per
 * kind, so a stranger filling the reset allowance (anyone can request a
 * reset for any address) does not stop a sign-in link, and one across every
 * kind, so splitting requests over kinds cannot flood an inbox. The owner is
 * never left without a way in: the last link sent is still in their inbox
 * and still valid, because a refused request issues no new token.
 */
export function mailAllowedTo(email: string, kind: string): boolean {
  const recipient = normalizeMemberEmail(email)
  if (!memberLimits.mailPerRecipientKind.consume(`${kind}|${recipient}`).ok) return false
  return memberLimits.mailPerRecipient.consume(recipient).ok
}

export function emailProblem(email: string): MemberOutcome | null {
  const trimmed = email.trim()
  if (!trimmed || trimmed.length > MEMBER_EMAIL_MAX_LENGTH || !ADDRESS_RE.test(trimmed)) {
    return fail('invalid_input', 'email')
  }
  return null
}

function passwordProblem(password: string, field = 'password'): MemberOutcome | null {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MEMBER_PASSWORD_MAX_LENGTH) {
    return fail('weak_password', field)
  }
  return null
}

/**
 * A hash no password matches, so a sign-in for an unknown address still pays
 * for one argon2 verification. Computed once, at first use.
 */
let dummyHash: Promise<string> | null = null
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('not-a-real-member-placeholder')
  return dummyHash
}

async function startSession(ctx: MemberActionContext, member: MemberRecord): Promise<MemberOutcome> {
  const session = await createMemberSession(ctx.db, member.id, ctx)
  await markMemberLoggedIn(ctx.db, member.id)
  emitMemberHook('member.signedIn', { memberId: member.id, email: member.email })
  const fresh = (await findMemberById(ctx.db, member.id)) ?? member
  const landing = (await getMemberPagePaths(ctx.db)).afterLogin
  return {
    ok: true,
    code: 'signed_in',
    session,
    member: await toCurrentMember(ctx.db, fresh),
    ...(landing ? { landing } : {}),
  }
}

function sendLink(
  ctx: MemberActionContext,
  kind: 'verify' | 'reset' | 'magic' | 'invite' | 'email_change',
  to: string,
  token: string,
  pages: MemberPagePaths,
): void {
  if (!ctx.linkOrigin) return
  // Callers check the page first (`linkPageMissing`); with none there is no link to send.
  const link = memberTokenLink(ctx.linkOrigin, pages, kind, token)
  if (!link) return
  queueMemberMail(ctx.db, { kind, to, link })
}

/**
 * A flow that ends in an emailed link needs a page of the site for the link
 * to open. Without one the flow is not offered at all: this is the answer,
 * the same for every address, before anything is looked up or sent.
 */
function linkPageMissing(
  pages: MemberPagePaths,
  kind: 'verify' | 'reset' | 'magic' | 'email_change',
): MemberOutcome | null {
  return memberLinkPage(pages, kind) ? null : fail('not_available')
}

// ─── Profile fields ────────────────────────────────────────────────────────

const TEXT_MAX = 200
const TEXTAREA_MAX = 2000

/**
 * Read the owner-defined profile fields out of a submitted form. Unknown
 * keys are ignored. Returns the first problem as a failed outcome.
 */
export function readProfileFields(
  fields: readonly MemberProfileField[],
  input: Record<string, string>,
  { partial }: { partial: boolean },
): { profile: MemberProfile } | { problem: MemberOutcome } {
  const profile: MemberProfile = {}
  for (const field of fields) {
    const raw = input[field.id]
    if (field.type === 'checkbox') {
      // An unticked checkbox is simply absent from a form post.
      if (raw === undefined && partial && !(`${field.id}__present` in input)) continue
      const checked = raw === 'on' || raw === 'true' || raw === '1'
      if (field.required && !checked) return { problem: fail('invalid_input', field.id) }
      profile[field.id] = checked
      continue
    }
    if (raw === undefined) {
      if (partial) continue
      if (field.required) return { problem: fail('invalid_input', field.id) }
      continue
    }
    const value = raw.trim()
    if (field.required && !value) return { problem: fail('invalid_input', field.id) }
    if (value.length > (field.type === 'textarea' ? TEXTAREA_MAX : TEXT_MAX)) {
      return { problem: fail('invalid_input', field.id) }
    }
    profile[field.id] = value
  }
  return { profile }
}

// ─── Sign up ───────────────────────────────────────────────────────────────

interface SignUpInput {
  email: string
  password: string
  fields: Record<string, string>
  ip: string
}

/**
 * Create an account, or rather: start proving the address.
 *
 * The member row is created without a password. The password hash travels in
 * the confirmation link's token and is applied only when the link is opened
 * in the browser that signed up (matched by the sign-up nonce cookie).
 *
 * That closes account pre-hijacking. Anyone can type someone else's address
 * into a sign-up form; the real owner then gets a confirmation email. If
 * they open it, in their own browser, the address is proven and they are
 * signed in, but the stranger's password is thrown away: the account has no
 * password until its owner sets one. Opening the link on another device
 * than the one you signed up on has the same harmless result.
 *
 * An address that already has a confirmed account gets an "you already have
 * an account" email instead; the visitor sees the same `check_email` answer.
 */
export async function signUp(ctx: MemberActionContext, input: SignUpInput): Promise<MemberOutcome> {
  const settings = await getMemberSettings(ctx.db)
  if (settings.signupMode === 'closed') return fail('signup_closed')
  if (settings.signupMode === 'invite') return fail('invite_required')
  const pages = await resolveMemberPagePaths(ctx.db, settings.pages)
  const noPage = linkPageMissing(pages, 'verify')
  if (noPage) return noPage

  const invalid = emailProblem(input.email) ?? passwordProblem(input.password)
  if (invalid) return invalid
  const read = readProfileFields(settings.profileFields, input.fields, { partial: false })
  if ('problem' in read) return read.problem
  if (!ctx.mailAvailable) return fail('email_unavailable')

  const perIp = memberLimits.signupPerIp.consume(input.ip)
  if (!perIp.ok) return limited(perIp.retryAfterMs)

  const email = input.email.trim()
  // Hash before looking the address up, so known and unknown addresses cost the same.
  const passwordHash = await hashPassword(input.password)
  const nonce = crypto.randomUUID()
  const outcome: MemberOutcome = { ok: true, code: 'check_email', signupNonce: nonce }

  // One recipient gets only a few sign-up emails an hour, whoever asks.
  if (!mailAllowedTo(email, 'signup')) return outcome

  let member = await findMemberByEmail(ctx.db, email)
  if (member && (member.emailVerifiedAt !== null || member.status !== 'active')) {
    if (member.status === 'active') {
      queueMemberMail(ctx.db, { kind: 'already_registered', to: member.email })
    }
    return outcome
  }

  if (!member) {
    member = await createMember(ctx.db, { email, passwordHash: null, profile: read.profile, verified: false })
    if (!member) return outcome // lost a race with another sign-up for the same address
    await recordMemberEvent(ctx.db, member.id, 'signup', ctx)
  }

  const { token } = await issueMemberToken(ctx.db, member.id, 'verify', {
    passwordHash,
    nonceHash: await hashSessionToken(nonce),
    profile: read.profile,
  })
  sendLink(ctx, 'verify', member.email, token, pages)
  return outcome
}

/** Open a confirmation link: prove the address, apply the password, sign in. */
export async function confirmEmail(
  ctx: MemberActionContext,
  input: { token: string; signupNonce: string | null; ip: string },
): Promise<MemberOutcome> {
  const perIp = memberLimits.tokenPerIp.consume(input.ip)
  if (!perIp.ok) return limited(perIp.retryAfterMs)

  const consumed = await consumeMemberToken(ctx.db, input.token, 'verify')
  if (!consumed) return fail('invalid_token')
  const member = await findMemberById(ctx.db, consumed.memberId)
  if (!member || member.status !== 'active') return fail('invalid_token')

  const sameBrowser =
    input.signupNonce !== null &&
    consumed.payload.nonceHash !== undefined &&
    (await hashSessionToken(input.signupNonce)) === consumed.payload.nonceHash
  if (consumed.payload.passwordHash && sameBrowser) {
    await setMemberPasswordHash(ctx.db, member.id, consumed.payload.passwordHash)
    if (consumed.payload.profile) await setMemberProfile(ctx.db, member.id, consumed.payload.profile)
  }
  await markMemberVerified(ctx.db, member.id)
  await recordMemberEvent(ctx.db, member.id, 'verified', ctx)
  return startSession(ctx, member)
}

// ─── Sign in and out ───────────────────────────────────────────────────────

export async function logIn(
  ctx: MemberActionContext,
  input: { email: string; password: string; ip: string },
): Promise<MemberOutcome> {
  const emailKey = normalizeMemberEmail(input.email).slice(0, MEMBER_EMAIL_MAX_LENGTH)
  const ipEmailKey = `${input.ip}|${emailKey}`
  // Every limit is reserved here, before the first `await`, so requests
  // arriving together cannot all slip under a limit while one is verifying.
  const perIp = memberLimits.loginPerIp.consume(input.ip)
  if (!perIp.ok) return limited(perIp.retryAfterMs)
  const newAddress = memberLimits.loginPerIpEmail.isUntouched(ipEmailKey)
  const perIpEmail = memberLimits.loginPerIpEmail.consume(ipEmailKey)
  if (!perIpEmail.ok) return limited(perIpEmail.retryAfterMs)
  // The per-email limit counts failures from everywhere, so a stranger can
  // run it out. To keep that from locking the owner out of their password,
  // an address that has not tried this email before gets one of a small,
  // capped number of further attempts.
  const perEmail = memberLimits.loginPerEmail.consume(emailKey)
  if (!perEmail.ok) {
    if (!newAddress) return limited(perEmail.retryAfterMs)
    const extra = memberLimits.loginPerEmailFromNewAddress.consume(emailKey)
    if (!extra.ok) return limited(extra.retryAfterMs)
  }

  const member = emailProblem(input.email) ? null : await findMemberByEmail(ctx.db, input.email)
  const password = input.password.slice(0, MEMBER_PASSWORD_MAX_LENGTH)
  // Always verify once, against a hash nothing matches when there is no
  // usable account, so timing says nothing about the address.
  const matches = await verifyPassword(password, member?.passwordHash ?? (await getDummyHash()))
  const accepted =
    member !== null && member.passwordHash !== null && matches && member.status === 'active' && member.emailVerifiedAt !== null
  if (!accepted) {
    if (member) await recordMemberEvent(ctx.db, member.id, 'login_failed', ctx)
    return fail('invalid_credentials')
  }

  // A sign-in that worked is not a failed attempt: give the slots back.
  memberLimits.loginPerIpEmail.reset(ipEmailKey)
  if (perEmail.ok) memberLimits.loginPerEmail.refund(emailKey)
  await recordMemberEvent(ctx.db, member.id, 'login', ctx)
  return startSession(ctx, member)
}

export async function logOut(ctx: MemberActionContext, current: SignedInMember | null): Promise<MemberOutcome> {
  if (current) {
    await revokeMemberSession(ctx.db, current.session.idHash)
    await recordMemberEvent(ctx.db, current.member.id, 'logout', ctx)
  }
  return { ok: true, code: 'signed_out', session: 'clear' }
}

// ─── Links by email: sign-in link, password reset ──────────────────────────

/**
 * Shared front half of "email me a link": the same limits, the same silent
 * drops, the same `check_email` answer whatever the address is.
 */
async function requestLink(
  ctx: MemberActionContext,
  input: { email: string; ip: string },
  kind: 'magic' | 'reset',
): Promise<MemberOutcome> {
  const pages = await getMemberPagePaths(ctx.db)
  const noPage = linkPageMissing(pages, kind)
  if (noPage) return noPage
  const invalid = emailProblem(input.email)
  if (invalid) return invalid
  if (!ctx.mailAvailable) return fail('email_unavailable')
  const perIp = memberLimits.mailPerIp.consume(input.ip)
  if (!perIp.ok) return limited(perIp.retryAfterMs)

  const outcome: MemberOutcome = { ok: true, code: 'check_email' }
  if (!mailAllowedTo(input.email, kind)) return outcome
  const member = await findMemberByEmail(ctx.db, input.email)
  if (!member || member.status !== 'active') return outcome

  const { token } = await issueMemberToken(ctx.db, member.id, kind)
  sendLink(ctx, kind, member.email, token, pages)
  await recordMemberEvent(
    ctx.db,
    member.id,
    kind === 'magic' ? 'magic_link_requested' : 'password_reset_requested',
    ctx,
  )
  return outcome
}

export function requestSignInLink(ctx: MemberActionContext, input: { email: string; ip: string }) {
  return requestLink(ctx, input, 'magic')
}

export function requestPasswordReset(ctx: MemberActionContext, input: { email: string; ip: string }) {
  return requestLink(ctx, input, 'reset')
}

/** Open a sign-in link. Holding it proves the address, so it also confirms it. */
export async function confirmSignInLink(
  ctx: MemberActionContext,
  input: { token: string; ip: string },
): Promise<MemberOutcome> {
  const perIp = memberLimits.tokenPerIp.consume(input.ip)
  if (!perIp.ok) return limited(perIp.retryAfterMs)
  const consumed = await consumeMemberToken(ctx.db, input.token, 'magic')
  if (!consumed) return fail('invalid_token')
  const member = await findMemberById(ctx.db, consumed.memberId)
  if (!member || member.status !== 'active') return fail('invalid_token')
  await markMemberVerified(ctx.db, member.id)
  await recordMemberEvent(ctx.db, member.id, 'login', ctx, { via: 'link' })
  return startSession(ctx, member)
}

/**
 * Choose a password with a reset or invite link. The password is checked
 * before the token is used up, so a too-short password does not burn the
 * link. Every existing session ends: whoever had access before no longer does.
 */
export async function setPasswordWithLink(
  ctx: MemberActionContext,
  input: { token: string; password: string; ip: string },
  kind: 'reset' | 'invite',
): Promise<MemberOutcome> {
  const perIp = memberLimits.tokenPerIp.consume(input.ip)
  if (!perIp.ok) return limited(perIp.retryAfterMs)
  const weak = passwordProblem(input.password)
  if (weak) return weak

  const consumed = await consumeMemberToken(ctx.db, input.token, kind)
  if (!consumed) return fail('invalid_token')
  const member = await findMemberById(ctx.db, consumed.memberId)
  if (!member || member.status !== 'active') return fail('invalid_token')

  await setMemberPasswordHash(ctx.db, member.id, await hashPassword(input.password))
  await markMemberVerified(ctx.db, member.id)
  await revokeAllMemberSessions(ctx.db, member.id)
  await revokeAllMemberAppGrants(ctx.db, member.id)
  await withdrawMemberTokens(ctx.db, member.id)
  await recordMemberEvent(ctx.db, member.id, 'password_reset', ctx)
  if (kind === 'reset') {
    queueMemberMail(ctx.db, { kind: 'password_changed', to: member.email })
  }
  return startSession(ctx, member)
}

// ─── Signed-in actions ─────────────────────────────────────────────────────

/**
 * Sensitive changes need the member to prove it is still them: the current
 * password, or, for a member who has none, having signed in within the last
 * 15 minutes.
 */
async function reauthenticate(
  current: SignedInMember,
  currentPassword: string | undefined,
): Promise<MemberOutcome | null> {
  const { member, session } = current
  if (!member.passwordHash) {
    const age = Date.now() - new Date(session.createdAt).getTime()
    return age <= RECENT_SIGN_IN_MS ? null : fail('reauth_required')
  }
  const decision = memberLimits.reauthPerMember.consume(member.id)
  if (!decision.ok) return limited(decision.retryAfterMs)
  const candidate = (currentPassword ?? '').slice(0, MEMBER_PASSWORD_MAX_LENGTH)
  if (!(await verifyPassword(candidate, member.passwordHash))) {
    return fail('invalid_credentials', 'currentPassword')
  }
  return null
}

export async function changePassword(
  ctx: MemberActionContext,
  current: SignedInMember,
  input: { currentPassword?: string; newPassword: string },
): Promise<MemberOutcome> {
  const weak = passwordProblem(input.newPassword, 'newPassword')
  if (weak) return weak
  const denied = await reauthenticate(current, input.currentPassword)
  if (denied) return denied

  const { member } = current
  await setMemberPasswordHash(ctx.db, member.id, await hashPassword(input.newPassword))
  // Replace this session too: a stolen copy of the old token dies with the rest.
  await revokeAllMemberSessions(ctx.db, member.id)
  await revokeAllMemberAppGrants(ctx.db, member.id)
  await withdrawMemberTokens(ctx.db, member.id)
  await recordMemberEvent(ctx.db, member.id, 'password_changed', ctx)
  queueMemberMail(ctx.db, { kind: 'password_changed', to: member.email })
  const fresh = await createMemberSession(ctx.db, member.id, ctx)
  return { ok: true, code: 'updated', session: fresh }
}

export async function requestEmailChange(
  ctx: MemberActionContext,
  current: SignedInMember,
  input: { email: string; currentPassword?: string; ip: string },
): Promise<MemberOutcome> {
  const pages = await getMemberPagePaths(ctx.db)
  const noPage = linkPageMissing(pages, 'email_change')
  if (noPage) return noPage
  const invalid = emailProblem(input.email)
  if (invalid) return invalid
  if (!ctx.mailAvailable) return fail('email_unavailable')
  const denied = await reauthenticate(current, input.currentPassword)
  if (denied) return denied
  const perIp = memberLimits.mailPerIp.consume(input.ip)
  if (!perIp.ok) return limited(perIp.retryAfterMs)

  const { member } = current
  const email = input.email.trim()
  const outcome: MemberOutcome = { ok: true, code: 'check_email' }
  if (normalizeMemberEmail(email) === member.emailNormalized) return outcome
  if (!mailAllowedTo(email, 'email_change')) return outcome
  // An address that belongs to someone else gets no mail and the same answer.
  if (await findMemberByEmail(ctx.db, email)) return outcome

  const { token } = await issueMemberToken(ctx.db, member.id, 'email_change', { email })
  sendLink(ctx, 'email_change', email, token, pages)
  queueMemberMail(ctx.db, { kind: 'email_change_notice', to: member.email })
  await recordMemberEvent(ctx.db, member.id, 'email_change_requested', ctx)
  return outcome
}

/** Open the link sent to the new address: move the account there. */
export async function confirmEmailChange(
  ctx: MemberActionContext,
  input: { token: string; ip: string },
): Promise<MemberOutcome> {
  const perIp = memberLimits.tokenPerIp.consume(input.ip)
  if (!perIp.ok) return limited(perIp.retryAfterMs)
  const consumed = await consumeMemberToken(ctx.db, input.token, 'email_change')
  if (!consumed || !consumed.payload.email) return fail('invalid_token')
  const member = await findMemberById(ctx.db, consumed.memberId)
  if (!member || member.status !== 'active') return fail('invalid_token')

  if (!(await setMemberEmail(ctx.db, member.id, consumed.payload.email))) return fail('email_taken')
  await revokeAllMemberSessions(ctx.db, member.id)
  await revokeAllMemberAppGrants(ctx.db, member.id)
  await withdrawMemberTokens(ctx.db, member.id)
  await recordMemberEvent(ctx.db, member.id, 'email_changed', ctx)
  return startSession(ctx, member)
}

export async function updateProfile(
  ctx: MemberActionContext,
  current: SignedInMember,
  fields: Record<string, string>,
): Promise<MemberOutcome> {
  const settings = await getMemberSettings(ctx.db)
  const read = readProfileFields(settings.profileFields, fields, { partial: true })
  if ('problem' in read) return read.problem
  const profile = { ...current.member.profile, ...read.profile }
  await setMemberProfile(ctx.db, current.member.id, profile)
  await recordMemberEvent(ctx.db, current.member.id, 'profile_updated', ctx)
  const fresh = (await findMemberById(ctx.db, current.member.id)) ?? current.member
  return { ok: true, code: 'updated', member: await toCurrentMember(ctx.db, fresh) }
}

export async function deleteAccount(
  ctx: MemberActionContext,
  current: SignedInMember,
  input: { currentPassword?: string },
): Promise<MemberOutcome> {
  const denied = await reauthenticate(current, input.currentPassword)
  if (denied) return denied
  await recordMemberEvent(ctx.db, current.member.id, 'deleted', ctx)
  await anonymizeMember(ctx.db, current.member.id)
  await discardQueuedMailForMember(ctx.db, current.member.id)
  return { ok: true, code: 'deleted', session: 'clear' }
}

/** Everything the site holds about a member, for their own download. */
export async function exportMemberData(db: DbClient, member: MemberRecord): Promise<Record<string, unknown>> {
  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: member.id,
      email: member.email,
      emailVerifiedAt: member.emailVerifiedAt,
      createdAt: member.createdAt,
      lastLoginAt: member.lastLoginAt,
      hasPassword: member.passwordHash !== null,
    },
    profile: member.profile,
    tags: await listActiveMemberTags(db, member.id),
    sessions: await listMemberSessions(db, member.id),
    connectedApps: (await listConnectedMemberApps(db, member.id)).map((app) => ({
      app: app.name,
      device: app.device,
      connectedAt: app.connectedAt,
      lastUsedAt: app.lastUsedAt,
    })),
    activity: await listMemberEvents(db, member.id),
  }
}
