import { describe, expect, it } from 'bun:test'
import { countDiffLines, diffLines } from '@core/utils/lineDiff'

describe('diffLines', () => {
  it('keeps unchanged lines and marks additions and removals with both line numbers', () => {
    const rows = diffLines('a\nb\nc\n', 'a\nx\nc\nd\n')
    expect(rows.map((row) => [row.type, row.before, row.after, row.text])).toEqual([
      ['same', 1, 1, 'a'],
      ['del', 2, null, 'b'],
      ['add', null, 2, 'x'],
      ['same', 3, 3, 'c'],
      ['add', null, 4, 'd'],
    ])
    expect(countDiffLines(rows)).toEqual({ additions: 2, deletions: 1 })
  })

  it('treats an empty side as all added or all removed', () => {
    expect(diffLines('', 'one\ntwo').map((row) => row.type)).toEqual(['add', 'add'])
    expect(diffLines('one', '').map((row) => row.type)).toEqual(['del'])
    expect(diffLines('', '')).toEqual([])
  })
})
