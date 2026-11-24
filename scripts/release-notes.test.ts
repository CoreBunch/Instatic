import { expect, test } from 'bun:test'
import { releaseNotes } from './release-notes'

const notes = '### Features\n\n- A new feature.\n\n```md\n## Example heading\n```'
const heading = '## 1.2.3 - 2026-11-22'
const changelog = ['## 1.2.30 - 2026-11-23', 'Later', heading, notes, '## 1.2.2 - 2026-11-21', 'Earlier'].join('\n\n')
const credits = '## New Contributors\n* @someone made their first contribution in #42'
const compare = '**Full Changelog**: https://example.com/compare/v1.2.2...v1.2.3'
const changes = "## What's Changed\n* Internal PR title"

test('uses the exact tagged entry and keeps contributor credits and the compare link', () => {
  const generated = [changes, credits, compare].join('\n\n')
  expect(releaseNotes('v1.2.3', changelog, generated)).toBe([notes, credits, compare].join('\n\n'))
})

test('handles releases with no first-time contributors or no generated footer', () => {
  expect(releaseNotes('v1.2.3', changelog, [changes, compare].join('\n\n'))).toBe(notes + '\n\n' + compare)
  expect(releaseNotes('v1.2.3', changelog, changes)).toBe(notes)
})

test('rejects missing, duplicate, or empty tagged entries', () => {
  expect(() => releaseNotes('v1.2.4', changelog, '')).toThrow('Expected one dated')
  expect(() => releaseNotes('v1.2.3', changelog + '\n\n' + heading, '')).toThrow('Expected one dated')
  expect(() => releaseNotes('v1.2.3', heading + '\n\n## 1.2.2 - 2026-11-21\nOlder', '')).toThrow('Empty')
})
