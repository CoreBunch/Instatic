/**
 * parseSiteFragment — the boundary rejects anything that is not a fragment.
 */

import { describe, expect, it } from 'bun:test'
import { zipSync, strToU8 } from 'fflate'
import {
  FragmentParseError,
  extractFragment,
  fragmentSourceFromSite,
  parseSiteFragment,
  readFragmentPackage,
  type SiteFragment,
} from '@core/fragments'
import { SOURCE_ROWS, SOURCE_TABLES, makeSourceSite, sourceMediaWithBytes } from './fixtures'

async function validFragment(): Promise<SiteFragment> {
  const source = fragmentSourceFromSite(makeSourceSite(), {
    tables: SOURCE_TABLES,
    rows: SOURCE_ROWS,
    media: sourceMediaWithBytes(),
  })
  return (await extractFragment(source, { pageId: 'page-home', rootNodeIds: ['hero'] })).fragment
}

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
  it('accepts what extractFragment writes', async () => {
    const fragment = await validFragment()
    expect(parseSiteFragment(JSON.parse(JSON.stringify(fragment)))).toEqual(fragment)
  })

  it('rejects a foreign format, a future version and non-objects', async () => {
    const fragment = await validFragment()
    expectParseError({ ...fragment, format: 'something-else' }, /format/)
    expectParseError({ ...fragment, version: 2 }, /version/)
    expectParseError('fragment', /fragment|^$/)
  })

  it('rejects roots that do not resolve and cyclic trees', async () => {
    const fragment = await validFragment()
    expectParseError({ ...fragment, roots: ['ghost'] }, /^roots$/)
    const cyclic = structuredClone(fragment)
    cyclic.nodes.title.children = ['hero']
    expectParseError(cyclic, /^nodes$/)
    const dangling = structuredClone(fragment)
    dangling.nodes.title.children = ['nowhere']
    expectParseError(dangling, /^nodes$/)
  })

  it('rejects kind payloads that do not match the kind', async () => {
    const fragment = await validFragment()
    expectParseError({ ...fragment, kind: 'page' }, /^page$/)
    expectParseError({ ...fragment, kind: 'component' }, /^component$/)
    expectParseError(
      { ...fragment, kind: 'component', component: { id: 'vc-card', name: 'Card' } },
      /^roots$/,
    )
  })

  it('rejects malformed media keys and duplicate ids', async () => {
    const fragment = await validFragment()
    const badKey = structuredClone(fragment)
    badKey.media[0].key = 'not-a-hash'
    expectParseError(badKey, /media/)
    const dupe = structuredClone(fragment)
    dupe.components.push(structuredClone(dupe.components[0]))
    expectParseError(dupe, /^components$/)
  })

  it('rejects a package whose manifest or media is missing', async () => {
    const fragment = await validFragment()
    expect(() => readFragmentPackage(zipSync({ 'other.json': strToU8('{}') }))).toThrow(FragmentParseError)
    expect(() => readFragmentPackage(zipSync({ 'fragment.json': strToU8('{oops') }))).toThrow(FragmentParseError)
    const withoutMedia = zipSync({ 'fragment.json': strToU8(JSON.stringify(fragment)) })
    expect(() => readFragmentPackage(withoutMedia)).toThrow(/is not in the package/)
  })
})
