/**
 * documentDiff — the minimal set of text changes that turn one document
 * into another, so an editor buffer can be brought up to date IN PLACE:
 * the caret, selection, folds and undo history all map through the changes
 * instead of being lost to a remount.
 *
 * Line-based: common leading and trailing lines are trimmed, the middle is
 * aligned with a longest-common-subsequence over lines, and each run of
 * differing lines becomes one change. Very large middles fall back to a
 * single replacement (the LCS table is quadratic).
 */

export interface DocumentChange {
  from: number
  to: number
  insert: string
}

/** Above this many differing lines on either side, use one replacement. */
const LCS_LINE_LIMIT = 1500

function splitLines(text: string): string[] {
  return text.split('\n')
}

/** Character offset of the start of line `index` (lines joined by `\n`). */
function lineStart(lines: readonly string[], index: number): number {
  let offset = 0
  for (let i = 0; i < index; i++) offset += lines[i].length + 1
  return offset
}

interface LineRegion {
  /** Old lines [oldFrom, oldTo) are replaced by new lines [newFrom, newTo). */
  oldFrom: number
  oldTo: number
  newFrom: number
  newTo: number
}

/** Align two line arrays (LCS) into replaced regions, in order. */
function lineRegions(oldLines: readonly string[], newLines: readonly string[]): LineRegion[] {
  const rows = oldLines.length
  const cols = newLines.length
  const table: Uint32Array[] = []
  for (let i = 0; i <= rows; i++) table.push(new Uint32Array(cols + 1))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const regions: LineRegion[] = []
  let i = 0
  let j = 0
  let open: LineRegion | null = null
  while (i < rows || j < cols) {
    if (i < rows && j < cols && oldLines[i] === newLines[j]) {
      if (open) {
        open.oldTo = i
        open.newTo = j
        regions.push(open)
        open = null
      }
      i++
      j++
      continue
    }
    open ??= { oldFrom: i, oldTo: i, newFrom: j, newTo: j }
    if (j < cols && (i >= rows || table[i][j + 1] >= table[i + 1][j])) j++
    else i++
  }
  if (open) {
    open.oldTo = i
    open.newTo = j
    regions.push(open)
  }
  return regions
}

/**
 * A line region as a character change. Lines are `\n`-joined; a region
 * followed by a kept line owns the newline after each of its lines, while
 * a region reaching the end of the document owns the newline BEFORE it
 * instead (there is none after).
 */
function regionChange(
  region: LineRegion,
  oldLines: readonly string[],
  newLines: readonly string[],
  oldTextLength: number,
): DocumentChange {
  const inserted = newLines.slice(region.newFrom, region.newTo)
  if (region.oldTo < oldLines.length) {
    const from = lineStart(oldLines, region.oldFrom)
    return { from, to: lineStart(oldLines, region.oldTo), insert: inserted.map((line) => `${line}\n`).join('') }
  }
  // Reaches the end of the old document.
  if (region.oldFrom === oldLines.length) {
    return { from: oldTextLength, to: oldTextLength, insert: `\n${inserted.join('\n')}` }
  }
  const removesEverythingAfter = inserted.length === 0 && region.oldFrom > 0
  const from = removesEverythingAfter ? lineStart(oldLines, region.oldFrom) - 1 : lineStart(oldLines, region.oldFrom)
  return { from, to: oldTextLength, insert: inserted.join('\n') }
}

export function documentChanges(oldText: string, newText: string): DocumentChange[] {
  if (oldText === newText) return []
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)
  const regions: LineRegion[] =
    oldMiddle.length > LCS_LINE_LIMIT || newMiddle.length > LCS_LINE_LIMIT
      ? [{ oldFrom: 0, oldTo: oldMiddle.length, newFrom: 0, newTo: newMiddle.length }]
      : lineRegions(oldMiddle, newMiddle)

  // Regions are relative to the middles; shift them back into the full
  // documents so the end-of-document rule sees the real end.
  return regions.map((region) =>
    regionChange(
      {
        oldFrom: region.oldFrom + prefix,
        oldTo: region.oldTo + prefix,
        newFrom: region.newFrom + prefix,
        newTo: region.newTo + prefix,
      },
      oldLines,
      newLines,
      oldText.length,
    ),
  )
}

/** Apply `changes` (non-overlapping, ascending) to `text` — for tests and callers without an editor. */
export function applyDocumentChanges(text: string, changes: readonly DocumentChange[]): string {
  let out = ''
  let cursor = 0
  for (const change of changes) {
    out += text.slice(cursor, change.from) + change.insert
    cursor = change.to
  }
  return out + text.slice(cursor)
}
