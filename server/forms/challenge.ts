import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const MAX_PUBLIC_FORM_CHALLENGES = 2_000
const fallbackSecret = randomBytes(32).toString('hex')
const signingSecret = process.env.INSTATIC_FORM_SECRET ?? process.env.INSTATIC_SECRET_KEY ?? fallbackSecret

type PublicFormChallengeRecord = {
  pageId: string
  formId: string
  challenge: string
  token: string
  issuedAt: number
  expiresAt: number
}

const challenges = new Map<string, PublicFormChallengeRecord>()

type VerifiedPublicFormChallenge =
  Pick<PublicFormChallengeRecord, 'pageId' | 'formId' | 'issuedAt' | 'expiresAt'>

export function issuePublicFormChallenge(input: {
  pageId: string
  formId: string
  now?: number
}): PublicFormChallengeRecord {
  const now = input.now ?? Date.now()
  prunePublicFormChallenges(now)
  evictOldestPublicFormChallenges()
  const challenge = randomBytes(18).toString('base64url')
  const expiresAt = now + CHALLENGE_TTL_MS
  const token = signChallenge({
    pageId: input.pageId,
    formId: input.formId,
    challenge,
    issuedAt: now,
    expiresAt,
  })
  const record = {
    pageId: input.pageId,
    formId: input.formId,
    challenge,
    token,
    issuedAt: now,
    expiresAt,
  }
  challenges.set(challenge, record)
  return record
}

export function verifyAndConsumePublicFormChallenge(input: {
  pageId: string
  formId: string
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
  if (record.pageId !== input.pageId || record.formId !== input.formId) return null
  if (!constantTimeEqual(record.token, input.token)) return null
  const expected = signChallenge(record)
  if (!constantTimeEqual(expected, input.token)) return null
  return {
    pageId: record.pageId,
    formId: record.formId,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  }
}

export function issuePublicFormPageToken(input: {
  pageId: string
  formId: string
}): string {
  return signPageToken(input)
}

export function verifyPublicFormPageToken(input: {
  pageId: string
  formId: string
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

function signChallenge(input: {
  pageId: string
  formId: string
  challenge: string
  issuedAt: number
  expiresAt: number
}): string {
  return createHmac('sha256', signingSecret)
    .update(input.pageId)
    .update('\0')
    .update(input.formId)
    .update('\0')
    .update(input.challenge)
    .update('\0')
    .update(String(input.issuedAt))
    .update('\0')
    .update(String(input.expiresAt))
    .digest('base64url')
}

function signPageToken(input: {
  pageId: string
  formId: string
}): string {
  return createHmac('sha256', signingSecret)
    .update('page-form')
    .update('\0')
    .update(input.pageId)
    .update('\0')
    .update(input.formId)
    .digest('base64url')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
