/**
 * parseSiteFragment — the boundary rejects anything that is not a fragment.
 */

import { describe, expect, it } from 'bun:test'
import { zipSync, strToU8 } from 'fflate'
import { FragmentParseError, parseSiteFragment, readFragmentPackage } from '@core/fragments'
import { extractFromSource } from './fixtures'

const { fragment } = await extractFromSource()

function expectParseError(value: unknown, path: RegExp): void {
  let caught: unknown
  try {
    parseSiteFragment(value)
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(FragmentParseError)
  expect((caught as FragmentParseError).path).toMatch(path)
}

describe('parseSiteFragment', () => {
  it('accepts what extractFragment writes', () => {
    expect(parseSiteFragment(JSON.parse(JSON.stringify(fragment)))).toEqual(fragment)
  })

  it('rejects a foreign format, a future version and non-objects', () => {
    expectParseError({ ...fragment, format: 'something-else' }, /format/)
    expectParseError({ ...fragment, version: 2 }, /version/)
    expectParseError('fragment', /fragment|^$/)
  })

  it('rejects roots that do not resolve and cyclic trees', () => {
    expectParseError({ ...fragment, roots: ['ghost'] }, /^roots$/)
    const cyclic = structuredClone(fragment)
    cyclic.nodes.title.children = ['hero']
    expectParseError(cyclic, /^nodes$/)
    const dangling = structuredClone(fragment)
    dangling.nodes.title.children = ['nowhere']
    expectParseError(dangling, /^nodes$/)
  })

  it('rejects kind payloads that do not match the kind', () => {
    expectParseError({ ...fragment, kind: 'page' }, /^page$/)
    expectParseError({ ...fragment, kind: 'component' }, /^component$/)
    expectParseError(
      { ...fragment, kind: 'component', component: { id: 'vc-card', name: 'Card' } },
      /^roots$/,
    )
  })

  it('rejects malformed media keys and duplicate ids', () => {
    const badKey = structuredClone(fragment)
    badKey.media[0].key = 'not-a-hash'
    expectParseError(badKey, /media/)
    const dupe = structuredClone(fragment)
    dupe.components.push(structuredClone(dupe.components[0]))
    expectParseError(dupe, /^components$/)
  })

  it('rejects a package whose manifest or media is missing', () => {
    expect(() => readFragmentPackage(zipSync({ 'other.json': strToU8('{}') }))).toThrow(FragmentParseError)
    expect(() => readFragmentPackage(zipSync({ 'fragment.json': strToU8('{oops') }))).toThrow(FragmentParseError)
    const withoutMedia = zipSync({ 'fragment.json': strToU8(JSON.stringify(fragment)) })
    expect(() => readFragmentPackage(withoutMedia)).toThrow(/is not in the package/)
  })
})
