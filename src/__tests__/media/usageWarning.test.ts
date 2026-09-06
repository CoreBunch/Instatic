/**
 * What a destructive confirmation says when part of the selection is in use.
 *
 * The scenario that produced these rules: eleven files selected, one of them
 * a profile picture, and the operator about to purge the lot. A warning that
 * says "some of these are in use" tells them nothing actionable; one that
 * blocks the delete stops them replacing their own avatar.
 */

import { describe, expect, it } from 'bun:test'
import { buildUsageWarning } from '@admin/pages/media/utils/usageWarning'

const avatar = (assetId: string, label: string) => ({
  assetId, refKind: 'user.avatar', refId: 'u1', label,
})

describe('the usage warning', () => {
  it('says nothing when nothing is depended on', () => {
    // The ordinary confirmation stands on its own; an empty warning box
    // would train people to ignore the space it occupies.
    expect(buildUsageWarning(11, [])).toBeNull()
  })

  it('separates the used from the safe', () => {
    // "1 of 11" is the whole point — it tells the operator the other ten
    // carry no risk, which a blanket warning never does.
    const warning = buildUsageWarning(11, [avatar('a1', 'Ada Lovelace')])
    expect(warning?.heading).toBe('1 of 11 is still in use:')
  })

  it('drops the count when everything selected is in use', () => {
    // "2 of 2" reads like arithmetic. Naming the state is clearer.
    const warning = buildUsageWarning(2, [avatar('a1', 'Ada'), avatar('a2', 'Grace')])
    expect(warning?.heading).toBe('These files are still in use:')
  })

  it('names what breaks rather than describing the reference', () => {
    const warning = buildUsageWarning(3, [avatar('a1', 'Ada Lovelace')])
    expect(warning?.lines).toEqual(['profile picture — Ada Lovelace'])
  })

  it('counts an asset once but names every place it is used', () => {
    // Two different things, and the warning has to get both right.
    //
    // The COUNT is about what disappears: one file is lost, not two, so "2 of
    // 4" would overstate the damage.
    //
    // The LINES are about where to go afterwards. Naming one of the two and
    // hiding the other sends the operator to fix half of it and leaves the
    // rest broken — which is how the warning would end up blamed for the
    // breakage it was meant to prevent.
    const warning = buildUsageWarning(4, [
      avatar('a1', 'Ada Lovelace'),
      { assetId: 'a1', refKind: 'user.avatar', refId: 'u2', label: 'Grace Hopper' },
    ])
    expect(warning?.heading).toBe('1 of 4 is still in use:')
    expect(warning?.lines).toEqual([
      'profile picture — Ada Lovelace',
      'profile picture — Grace Hopper',
    ])
  })

  it('names each page a file appears on, because each one breaks', () => {
    const onPage = (refId: string, title: string) => ({
      assetId: 'a1', refKind: 'page.content', refId, label: title,
    })
    const warning = buildUsageWarning(1, [
      onPage('p1', 'Home'),
      onPage('p2', 'About us'),
    ])
    expect(warning?.heading).toBe('This file is still in use:')
    expect(warning?.lines).toEqual([
      'on the page — Home',
      'on the page — About us',
    ])
  })

  it('describes a site-wide background without pretending it is a page', () => {
    const warning = buildUsageWarning(1, [
      { assetId: 'a1', refKind: 'site.styles', refId: 'site', label: 'site styles' },
    ])
    expect(warning?.lines).toEqual(['a site-wide background style'])
  })

  it('summarises past three so the dialog stays readable', () => {
    const refs = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id, i) => avatar(id, `User ${i + 1}`))
    const warning = buildUsageWarning(20, refs)
    expect(warning?.lines).toHaveLength(4)
    expect(warning?.lines.at(-1)).toBe('and 2 more')
  })

  it('does not summarise at exactly three', () => {
    const refs = ['a1', 'a2', 'a3'].map((id, i) => avatar(id, `User ${i + 1}`))
    expect(buildUsageWarning(9, refs)?.lines).toHaveLength(3)
  })

  it('uses singular and plural correctly', () => {
    expect(buildUsageWarning(5, [avatar('a1', 'Ada')])?.heading).toContain(' is still')
    expect(
      buildUsageWarning(5, [avatar('a1', 'Ada'), avatar('a2', 'Grace')])?.heading,
    ).toContain(' are still')
  })
})
