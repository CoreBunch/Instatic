/**
 * Conditional visibility — showing a node only when its row says so.
 *
 * The case that motivated it: a card holds a video player and a "Coming soon"
 * caption, and exactly one belongs on any given row. Without this the card can
 * be built only one way, so every row gets a blank player or every row gets the
 * caption.
 *
 * `isNodeVisible` is asked by the publisher and deliberately not by the editor
 * canvas — a node hidden because the preview row has no video is a node the
 * author cannot click. That asymmetry is the one place the two surfaces differ,
 * so it is pinned here rather than left to be rediscovered.
 */

import { describe, expect, test } from 'bun:test'
import { isNodeVisible } from '../dynamicBindings'
import { parseVisibilityCondition, isValueSet } from '@core/page-tree'
import type { TemplateRenderDataContext } from '../renderDataContext'

/** A render context with one entry on the stack, as a loop iteration has. */
const withEntry = (fields: Record<string, unknown>): TemplateRenderDataContext =>
  ({ entryStack: [{ fields }] }) as unknown as TemplateRenderDataContext

const showIfVideo = { source: 'currentEntry', field: 'video', test: 'isSet' } as const
const showIfNoVideo = { source: 'currentEntry', field: 'video', test: 'isNotSet' } as const

describe('isNodeVisible', () => {
  test('the player shows on a row that has a video', () => {
    expect(isNodeVisible({ visibleWhen: showIfVideo }, withEntry({ video: '/a.mp4' }))).toBe(true)
  })

  test('the player hides on a row that has none', () => {
    expect(isNodeVisible({ visibleWhen: showIfVideo }, withEntry({ video: '' }))).toBe(false)
    expect(isNodeVisible({ visibleWhen: showIfVideo }, withEntry({}))).toBe(false)
  })

  test('the caption is the exact inverse', () => {
    // The pair must never both show or both hide — that is the whole point.
    for (const row of [{ video: '/a.mp4' }, { video: '' }, {}]) {
      const player = isNodeVisible({ visibleWhen: showIfVideo }, withEntry(row))
      const caption = isNodeVisible({ visibleWhen: showIfNoVideo }, withEntry(row))
      expect(player).toBe(!caption)
    }
  })

  test('a node with no condition always shows', () => {
    expect(isNodeVisible({}, withEntry({}))).toBe(true)
  })

  test('no render context means visible', () => {
    // A template rendered outside any entry route has nothing to test against,
    // and vanishing would be a strange reading of "show when the row has a
    // video" on a page that has no row.
    expect(isNodeVisible({ visibleWhen: showIfVideo }, undefined)).toBe(true)
  })

  test('a missing frame reads as unset, not as an error', () => {
    const noEntries = { entryStack: [] } as unknown as TemplateRenderDataContext
    expect(isNodeVisible({ visibleWhen: showIfVideo }, noEntries)).toBe(false)
    expect(isNodeVisible({ visibleWhen: showIfNoVideo }, noEntries)).toBe(true)
  })

  test('reads a dotted path like the prop bindings do', () => {
    const cond = { source: 'currentEntry', field: 'author.name', test: 'isSet' } as const
    expect(isNodeVisible({ visibleWhen: cond }, withEntry({ author: { name: 'Ada' } }))).toBe(true)
    expect(isNodeVisible({ visibleWhen: cond }, withEntry({ author: { name: '' } }))).toBe(false)
  })
})

describe('isValueSet', () => {
  test('counts what a reader would actually see', () => {
    expect(isValueSet('text')).toBe(true)
    expect(isValueSet(0)).toBe(true)      // a real number, shown as "0"
    expect(isValueSet(true)).toBe(true)
    expect(isValueSet(['a'])).toBe(true)
    expect(isValueSet({ a: 1 })).toBe(true)
  })

  test('and what it does not', () => {
    expect(isValueSet(undefined)).toBe(false)
    expect(isValueSet(null)).toBe(false)
    expect(isValueSet('')).toBe(false)
    expect(isValueSet('   ')).toBe(false)  // whitespace is not content
    expect(isValueSet([])).toBe(false)
    expect(isValueSet({})).toBe(false)
    expect(isValueSet(false)).toBe(false)  // an unset checkbox reads as unset
  })
})

describe('parseVisibilityCondition', () => {
  test('accepts a well-formed condition', () => {
    expect(parseVisibilityCondition(showIfVideo)).toEqual({ ...showIfVideo })
  })

  test('anything malformed becomes undefined, so the node stays visible', () => {
    // The only safe direction: a bad condition must never silently erase
    // content that was rendering fine.
    for (const bad of [
      null, undefined, 'nope', [],
      { source: 'nonsense', field: 'video', test: 'isSet' },
      { source: 'currentEntry', field: '', test: 'isSet' },
      { source: 'currentEntry', field: 'video', test: 'equals' },
      { source: 'currentEntry', field: 'video' },
    ]) {
      expect(parseVisibilityCondition(bad)).toBeUndefined()
    }
  })
})
