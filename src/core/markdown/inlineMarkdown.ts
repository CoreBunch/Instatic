/**
 * Inline serialiser for the content editor: turns the inline children of a
 * ProseMirror block (text runs with marks, hard breaks) into markdown by
 * emitting mark deltas between consecutive runs.
 */

import { sameMark, type JSONMark, type JSONNode } from './proseMirrorJson'

interface InlineRun {
  text: string
  marks: JSONMark[]
}

export function inlineToMarkdown(nodes: JSONNode[]): string {
  const runs: InlineRun[] = []
  collectInlineRuns(nodes, runs)
  return runsToMarkdown(runs)
}

function collectInlineRuns(nodes: JSONNode[], runs: InlineRun[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push({ text: node.text ?? '', marks: node.marks ?? [] })
    } else if (node.type === 'hardBreak') {
      runs.push({ text: '\n', marks: [] })
    }
    // Other inline node types (none today) would slot in here.
  }
}

const MARK_OPEN: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
}

// Marks with asymmetric open/close (link, underline) are handled
// explicitly in `openMark` / `closeMark`. Listed here purely so the
// mark-sort below has a stable ordering for them.
const MARK_ORDER = ['link', 'underline', 'code', 'bold', 'italic', 'strike']

// CommonMark only reads `**`, `*` and `~~` as emphasis when the opening
// delimiter is followed by, and the closing one preceded by, a
// non-whitespace character. `**word **` stays literal asterisks.
const FLANKING_MARKS = ['bold', 'italic', 'strike']

function runsToMarkdown(runs: InlineRun[]): string {
  // Normalise mark order so identical mark sets produce identical
  // open/close sequences. Code is the innermost mark by convention.
  const normalised = expelEdgeWhitespace(runs).map((run) => ({
    text: run.text,
    marks: [...run.marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type)),
  }))

  let out = ''
  const active: JSONMark[] = []
  for (const run of normalised) {
    const next = run.marks
    // Close marks that aren't in `next` (in reverse open order).
    while (active.length > 0 && !marksContain(next, active[active.length - 1])) {
      const closed = active.pop()
      if (closed) out += closeMark(closed)
    }
    // Open marks that aren't in `active`.
    for (const mark of next) {
      if (!marksContain(active, mark)) {
        out += openMark(mark)
        active.push(mark)
      }
    }
    out += escapeInline(run.text, active)
  }
  while (active.length > 0) {
    const closed = active.pop()
    if (closed) out += closeMark(closed)
  }
  return out
}

/**
 * Move the whitespace at the edges of every bold / italic / strike span
 * out of that span, so a run `word ` marked bold serialises as
 * `**word** ` rather than `**word **`. A span made only of whitespace
 * loses the mark. Whitespace inside a span, including the trailing space
 * of a run the mark continues past, stays marked.
 */
function expelEdgeWhitespace(runs: InlineRun[]): InlineRun[] {
  const pieces = runs.flatMap(splitEdgeWhitespace)
  for (const type of FLANKING_MARKS) {
    let start = 0
    while (start < pieces.length) {
      if (!pieces[start].marks.some((m) => m.type === type)) {
        start++
        continue
      }
      let end = start
      while (end + 1 < pieces.length && pieces[end + 1].marks.some((m) => m.type === type)) end++
      let first = start
      while (first <= end && isWhitespace(pieces[first].text)) {
        pieces[first] = withoutMark(pieces[first], type)
        first++
      }
      let last = end
      while (last >= first && isWhitespace(pieces[last].text)) {
        pieces[last] = withoutMark(pieces[last], type)
        last--
      }
      start = end + 1
    }
  }
  return pieces
}

function splitEdgeWhitespace(run: InlineRun): InlineRun[] {
  const [, lead = '', core = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text) ?? []
  return [lead, core, trail].filter((text) => text.length > 0).map((text) => ({ text, marks: run.marks }))
}

function isWhitespace(text: string): boolean {
  return /^\s+$/.test(text)
}

function withoutMark(run: InlineRun, type: string): InlineRun {
  return { text: run.text, marks: run.marks.filter((m) => m.type !== type) }
}

function marksContain(list: JSONMark[], mark: JSONMark): boolean {
  return list.some((m) => sameMark(m, mark))
}

function openMark(mark: JSONMark): string {
  if (mark.type === 'link') return '['
  if (mark.type === 'underline') return '<u>'
  return MARK_OPEN[mark.type] ?? ''
}

function closeMark(mark: JSONMark): string {
  if (mark.type === 'link') {
    const href = (mark.attrs?.href ?? '') as string
    return `](${href})`
  }
  if (mark.type === 'underline') return '</u>'
  return MARK_OPEN[mark.type] ?? ''
}

function escapeInline(text: string, marks: JSONMark[]): string {
  // Inside a code mark, no escaping (and no marks inside it anyway).
  if (marks.some((m) => m.type === 'code')) return text
  // Escape characters that would otherwise be parsed as markdown.
  return text.replace(/([\\`*_~[\]])/g, '\\$1')
}
