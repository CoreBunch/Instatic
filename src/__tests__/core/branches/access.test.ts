/**
 * The branch access rule shared by the server gates and the admin UI.
 *
 * `create` reaches only the branches the actor forked; `manage` reaches every
 * branch and is the only capability that merges or declines. A branch with no
 * recorded creator (its author was deleted) is a manager's to act on, never a
 * creator's.
 */
import { describe, expect, it } from 'bun:test'
import { canActOnBranch, canMergeBranches } from '@core/branches'

const mine = { createdByUserId: 'u1' }
const theirs = { createdByUserId: 'u2' }
const orphaned = { createdByUserId: null }

const creator = { id: 'u1', capabilities: ['site.read', 'site.branches.create'] }
const manager = { id: 'u3', capabilities: ['site.read', 'site.branches.manage'] }
const reader = { id: 'u1', capabilities: ['site.read'] }

describe('canActOnBranch', () => {
  it('lets a creator act on the branches they forked and nothing else', () => {
    expect(canActOnBranch(creator, mine)).toBe(true)
    expect(canActOnBranch(creator, theirs)).toBe(false)
    expect(canActOnBranch(creator, orphaned)).toBe(false)
  })

  it('lets a manager act on every branch, including orphaned ones', () => {
    expect(canActOnBranch(manager, mine)).toBe(true)
    expect(canActOnBranch(manager, theirs)).toBe(true)
    expect(canActOnBranch(manager, orphaned)).toBe(true)
  })

  it('gives a plain reader nothing, even on a branch that names them', () => {
    expect(canActOnBranch(reader, mine)).toBe(false)
  })

  it('gives a signed-out actor nothing', () => {
    expect(canActOnBranch(null, mine)).toBe(false)
    expect(canMergeBranches(null)).toBe(false)
  })
})

describe('canMergeBranches', () => {
  it('is managers only: forking a branch never implies landing it', () => {
    expect(canMergeBranches(manager)).toBe(true)
    expect(canMergeBranches(creator)).toBe(false)
    expect(canMergeBranches(reader)).toBe(false)
  })
})
