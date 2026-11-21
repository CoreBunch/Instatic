/**
 * Site members and admin users are two separate worlds.
 *
 * Members sign in on the published site; admin users sign in to `/admin`.
 * They have different tables, different cookies and different code. A member
 * session must never be able to stand in for an admin one, or the reverse,
 * and the simplest way to guarantee that is to keep the two code paths from
 * touching each other at all:
 *
 *  1. `server/members/` uses none of the admin auth funnel: no capability
 *     checks, no admin session lookups, no admin cookie, no admin tables.
 *     It may share the stateless primitives (hashing, origin checks, rate
 *     limiter).
 *  2. Nothing on the admin side reads the member cookie or resolves a member
 *     session.
 *  3. The member tables are queried only from `server/members/`.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SERVER = join(ROOT, 'server')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

function offenders(files: string[], patterns: RegExp[]): string[] {
  const found: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf-8')
    for (const pattern of patterns) {
      if (pattern.test(source)) found.push(`${relative(ROOT, file)} matches ${pattern}`)
    }
  }
  return found
}

const memberFiles = sourceFiles(join(SERVER, 'members'))
const everythingElse = sourceFiles(SERVER).filter(
  (file) => !file.startsWith(join(SERVER, 'members')) && !file.startsWith(join(SERVER, 'db')),
)

describe('members / admin split', () => {
  it('finds the member module', () => {
    expect(memberFiles.length).toBeGreaterThan(5)
  })

  it('keeps the admin auth funnel out of server/members', () => {
    expect(
      offenders(memberFiles, [
        /from '\.\.\/auth\/(authz|sessions|capabilities|lockout|mfa|totpSecrets|stepUpPolicy)'/,
        /from '\.\.\/repositories\/(users|sessions|roles|loginAttempts)'/,
        /from '\.\.\/handlers\/cms\//,
        /\bSESSION_COOKIE_NAME\b/,
        /\b(requireCapability|requireAnyCapability|requireAuthenticatedUser|findUserBySessionHash)\b/,
        /\b(from|join|into|update)\s+(users|sessions|roles)\b/i,
      ]),
    ).toEqual([])
  })

  it('lets server/members import only the stateless auth primitives', () => {
    const allowed = new Set(['tokens', 'security', 'rateLimit'])
    const bad: string[] = []
    for (const file of memberFiles) {
      for (const match of readFileSync(file, 'utf-8').matchAll(/from '\.\.\/auth\/([A-Za-z]+)'/g)) {
        if (!allowed.has(match[1])) bad.push(`${relative(ROOT, file)} imports auth/${match[1]}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('keeps member sessions out of the admin and every other server module', () => {
    const adminSide = everythingElse.filter(
      (file) => file.startsWith(join(SERVER, 'auth')) || file.startsWith(join(SERVER, 'handlers', 'cms')),
    )
    expect(
      offenders(adminSide, [
        /\b(readMemberSessionToken|findMemberSession|resolveSignedInMember|createMemberSession)\b/,
      ]),
    ).toEqual([])
  })

  it('queries the member tables only from server/members', () => {
    expect(
      offenders(everythingElse, [
        /\b(from|join|into|update)\s+(members|member_sessions|member_tokens|member_tags|member_events|member_settings)\b/i,
      ]),
    ).toEqual([])
  })
})
