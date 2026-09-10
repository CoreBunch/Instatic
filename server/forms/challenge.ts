import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PublicFormIdentity } from '@core/forms'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const MAX_PUBLIC_FORM_CHALLENGES = 2_000
const fallbackSecret = randomBytes(32).toString('hex')
const signingSecret = process.env.INSTATIC_FORM_SECRET ?? process.env.INSTATIC_SECRET_KEY ?? fallbackSecret

type PublicFormChallengeRecord = PublicFormIdentity & {
  challenge: string
  token: string
  issuedAt: number
  expiresAt: number
}

const challenges = new Map<string, PublicFormChallengeRecord>()

type VerifiedPublicFormChallenge = PublicFormIdentity & Pick<PublicFormChallengeRecord, 'issuedAt' | 'expiresAt'>

export function issuePublicFormChallenge(input: PublicFormIdentity & {
  now?: number
}): PublicFormChallengeRecord {
  const now = input.now ?? Date.now()
  prunePublicFormChallenges(now)
  evictOldestPublicFormChallenges()
  const challenge = randomBytes(18).toString('base64url')
  const expiresAt = now + CHALLENGE_TTL_MS
  const token = signChallenge({
    ...formIdentity(input),
    challenge,
    issuedAt: now,
    expiresAt,
  })
  const record = {
    ...formIdentity(input),
    challenge,
    token,
    issuedAt: now,
    expiresAt,
  }
  challenges.set(challenge, record)
  return record
}

export function verifyAndConsumePublicFormChallenge(input: PublicFormIdentity & {
  challenge: string
  token: string
  now?: number
}): VerifiedPublicFormChallenge | null {
  const now = input.now ?? Date.now()
  prunePublicFormChallenges(now)
  const record = challenges.get(input.challenge)
  if (!record) return null
  challenges.delete(input.challenge)
  if (record.expiresAt < now) return null
  if (identityKey(record) !== identityKey(input)) return null
  if (!constantTimeEqual(record.token, input.token)) return null
  const expected = signChallenge(record)
  if (!constantTimeEqual(expected, input.token)) return null
  return {
    ...formIdentity(record),
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  }
}

export function issuePublicFormPageToken(input: PublicFormIdentity): string {
  return signPageToken(input)
}

export function verifyPublicFormPageToken(input: PublicFormIdentity & {
  pageToken: string
}): boolean {
  return constantTimeEqual(signPageToken(input), input.pageToken)
}

export function resetPublicFormChallenges(): void {
  challenges.clear()
}

function prunePublicFormChallenges(now: number): void {
  for (const [challenge, record] of challenges) {
    if (record.expiresAt < now) challenges.delete(challenge)
  }
}

function evictOldestPublicFormChallenges(): void {
  while (challenges.size >= MAX_PUBLIC_FORM_CHALLENGES) {
    const oldest = challenges.keys().next().value
    if (!oldest) return
    challenges.delete(oldest)
  }
}

function formIdentity(input: PublicFormIdentity): PublicFormIdentity {
  return { pageId: input.pageId, localeId: input.localeId, publishedVersionId: input.publishedVersionId, pagePath: input.pagePath, formId: input.formId }
}

function identityKey(input: PublicFormIdentity): string {
  return JSON.stringify([input.pageId, input.localeId, input.publishedVersionId, input.pagePath, input.formId])
}

function signChallenge(input: PublicFormIdentity & { challenge: string; issuedAt: number; expiresAt: number }): string {
  return createHmac('sha256', signingSecret)
    .update(JSON.stringify(['form-challenge', identityKey(input), input.challenge, input.issuedAt, input.expiresAt]))
    .digest('base64url')
}

function signPageToken(input: PublicFormIdentity): string {
  return createHmac('sha256', signingSecret).update(JSON.stringify(['page-form', identityKey(input)])).digest('base64url')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
