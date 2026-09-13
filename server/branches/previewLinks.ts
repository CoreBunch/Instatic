/**
 * Branch preview links — how a reviewer without an admin account sees a
 * branch's draft on the public site.
 *
 *   1. An editor issues a link: a random token, stored hashed on
 *      `site_branch_previews`, one active link per branch.
 *   2. Opening `/_instatic/preview/<token>` validates it and sets an
 *      HttpOnly cookie carrying the token, then redirects to the site root.
 *   3. Every public GET with that cookie renders the branch's draft instead
 *      of the published site (see server/publish/branchPreview.ts), with a
 *      banner offering `/_instatic/preview/exit`, which clears the cookie.
 *
 * Revoking (or deleting the branch) invalidates the cookie on the next
 * request — the cookie is only ever the token, never a grant of its own.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { DbClient } from '../db/client'
import { publicOriginIsHttps } from '../auth/security'
import {
  createBranchPreview,
  resolveBranchPreviewToken,
  type BranchPreview,
} from '../repositories/branchPreviews'
import { branchExists } from '../repositories/branches'

export const BRANCH_PREVIEW_COOKIE = 'instatic_branch_preview'
export const BRANCH_PREVIEW_PATH_PREFIX = '/_instatic/preview/'
export const BRANCH_PREVIEW_EXIT_PATH = `${BRANCH_PREVIEW_PATH_PREFIX}exit`
/** A preview cookie outlives a typical review round; revocation is the real bound. */
const PREVIEW_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/

export function hashPreviewToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** `/_instatic/preview/<token>` — the path a shared link points at. */
export function previewEntryPath(token: string): string {
  return `${BRANCH_PREVIEW_PATH_PREFIX}${token}`
}

/** The token from an entry path, or null when the path is not one. */
export function previewTokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith(BRANCH_PREVIEW_PATH_PREFIX)) return null
  const token = pathname.slice(BRANCH_PREVIEW_PATH_PREFIX.length)
  return TOKEN_PATTERN.test(token) ? token : null
}

export async function issueBranchPreviewLink(
  db: DbClient,
  input: { branchId: string; createdByUserId: string | null },
): Promise<{ token: string; preview: BranchPreview }> {
  const token = randomBytes(24).toString('base64url')
  const preview = await createBranchPreview(db, {
    branchId: input.branchId,
    tokenHash: hashPreviewToken(token),
    createdByUserId: input.createdByUserId,
  })
  return { token, preview }
}

/** The branch a token currently grants, or null when it is unknown or revoked. */
export async function resolvePreviewToken(db: DbClient, token: string): Promise<string | null> {
  if (!TOKEN_PATTERN.test(token)) return null
  const branchId = await resolveBranchPreviewToken(db, hashPreviewToken(token))
  if (!branchId || !(await branchExists(db, branchId))) return null
  return branchId
}

function readCookie(req: Request, name: string): string {
  const cookie = req.headers.get('cookie') ?? ''
  for (const part of cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey === name) return rawValue.join('=')
  }
  return ''
}

/** The branch this request previews via its cookie, or null. */
export async function resolvePreviewCookie(req: Request, db: DbClient): Promise<string | null> {
  const token = readCookie(req, BRANCH_PREVIEW_COOKIE)
  if (!token) return null
  return resolvePreviewToken(db, token)
}

function cookieAttributes(req: Request): string {
  const secure = publicOriginIsHttps() || req.url.startsWith('https://')
  const base = 'Path=/; HttpOnly; SameSite=Lax'
  return secure ? `${base}; Secure` : base
}

export function previewCookie(req: Request, token: string): string {
  return `${BRANCH_PREVIEW_COOKIE}=${token}; ${cookieAttributes(req)}; Max-Age=${PREVIEW_COOKIE_MAX_AGE_SECONDS}`
}

export function clearPreviewCookie(req: Request): string {
  return `${BRANCH_PREVIEW_COOKIE}=; ${cookieAttributes(req)}; Max-Age=0`
}
