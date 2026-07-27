/**
 * Unit tests for the `visitor.current` loop source — the per-visitor
 * personalisation source (Use-case A of the visitor-data framework).
 *
 * Mirrors the static-shape + fetch style of `dataRowsSource.test.ts`, but
 * also exercises `fetch()` since `VisitorCurrentSource.fetch()` is pure: it
 * never touches `ctx.db`, so no `createTestDb()` is required. The whole
 * behaviour is a pure projection of `ctx.visitor`.
 *
 * The load-bearing contract pinned here:
 *   - the source is `perVisitor: true` (cookie-derived, never baked),
 *   - anonymous requests (no `ctx.visitor`) render nothing,
 *   - a logged-in visitor resolves to exactly one item carrying their
 *     identity + every custom profile field (spread dynamically),
 *   - identity is derived SOLELY from `ctx.visitor` — junk in `ctx.request`
 *     / `ctx.filters` is ignored entirely (IDOR-safe by construction).
 */
import { describe, expect, it } from 'bun:test'
import { VisitorCurrentSource } from '@core/loops/sources/visitorCurrent'

/**
 * Build a minimal `SourceFetchContext`-shaped object. `fetch()` reads only
 * `ctx.visitor`, so the other keys are inert — cast `as any` to satisfy the
 * type without importing internal helpers, matching how the loop test suite
 * constructs ctx literals.
 */
function makeCtx(visitor: unknown | undefined): any {
  return {
    db: undefined,
    site: {},
    filters: {},
    orderBy: 'createdAt',
    direction: 'desc',
    limit: 50,
    offset: 0,
    visitor,
  }
}

describe('visitor.current loop source', () => {
  it('declares its id and per-visitor classification', () => {
    expect(VisitorCurrentSource.id).toBe('visitor.current')
    expect(VisitorCurrentSource.perVisitor).toBe(true)
  })

  it('declares the core identity fields', () => {
    const fieldIds = VisitorCurrentSource.fields.map((field) => field.id)
    expect(fieldIds).toContain('id')
    expect(fieldIds).toContain('displayName')
    expect(fieldIds).toContain('email')
    expect(fieldIds).toContain('roleName')
  })

  it('renders nothing for an anonymous request (no ctx.visitor)', async () => {
    const result = await VisitorCurrentSource.fetch(makeCtx(undefined))
    expect(result).toEqual({ items: [], totalItems: 0 })
  })

  it('emits exactly one item projecting the visitor identity + custom profile fields', async () => {
    const visitor = {
      id: 'v_123',
      displayName: 'Ada Visitor',
      email: 'ada@example.com',
      roleName: 'member',
      profileFields: { schoolName: 'Oasis', grade: 'Y2' },
    }
    const result = await VisitorCurrentSource.fetch(makeCtx(visitor))

    expect(result.totalItems).toBe(1)
    expect(result.items).toHaveLength(1)

    const item = result.items[0]!
    // Identity
    expect(item.id).toBe('v_123')
    expect(item.fields['id']).toBe('v_123')
    expect(item.fields['displayName']).toBe('Ada Visitor')
    expect(item.fields['email']).toBe('ada@example.com')
    expect(item.fields['roleName']).toBe('member')
    // Custom profile fields spread dynamically (schoolName binding resolves).
    expect(item.fields['schoolName']).toBe('Oasis')
    expect(item.fields['grade']).toBe('Y2')
  })

  it('ignores ctx.request and ctx.filters entirely (identity is cookie-derived)', async () => {
    const visitor = {
      id: 'v_solo',
      displayName: 'Solo',
      email: 'solo@example.com',
      roleName: null,
      profileFields: {},
    }
    // Junk request + filters that, if trusted, would change the output.
    const ctx = makeCtx(visitor)
    ctx.request = {
      query: { id: 'attacker', displayName: 'Attacker' },
      path: '/impersonate',
      slug: 'forged',
      cookies: { visitor_session: 'forged-token' },
    }
    ctx.filters = { id: 'forged-id', schoolName: 'Tampered' }

    const result = await VisitorCurrentSource.fetch(ctx)

    expect(result.totalItems).toBe(1)
    const item = result.items[0]!
    // Output reflects ONLY ctx.visitor — request/filters never leak in.
    expect(item.id).toBe('v_solo')
    expect(item.fields['id']).toBe('v_solo')
    expect(item.fields['displayName']).toBe('Solo')
    expect(item.fields['email']).toBe('solo@example.com')
    expect(item.fields['schoolName']).toBeUndefined()
  })
})
