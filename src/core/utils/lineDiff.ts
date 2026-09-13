/**
 * Line diff of two texts (longest common subsequence). Small inputs only —
 * site files and plugin sources — so the O(n·m) table is fine and the
 * result stays exact. Rows come out in reading order with both line numbers.
 */
export interface DiffLine {
  type: 'same' | 'add' | 'del'
  /** Line number on the before side, null for an added line. */
  before: number | null
  /** Line number on the after side, null for a removed line. */
  after: number | null
  text: string
}

function splitLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\n$/, '').split('\n')
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const n = a.length
  const m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const rows: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', before: i + 1, after: j + 1, text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ type: 'del', before: i + 1, after: null, text: a[i]! })
      i++
    } else {
      rows.push({ type: 'add', before: null, after: j + 1, text: b[j]! })
      j++
    }
  }
  while (i < n) rows.push({ type: 'del', before: i + 1, after: null, text: a[i++]! })
  while (j < m) rows.push({ type: 'add', before: null, after: j + 1, text: b[j++]! })
  return rows
}

export function countDiffLines(rows: readonly DiffLine[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const row of rows) {
    if (row.type === 'add') additions++
    else if (row.type === 'del') deletions++
  }
  return { additions, deletions }
}
