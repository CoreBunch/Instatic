/**
 * Exact-text replacement engine shared by every "patch this file" agent
 * tool (site code assets, plugin IDE files).
 *
 * Deliberately never uses `String.prototype.replace` with a string
 * replacement: that API interprets `$$`, `$&`, `` $` `` and `$'` in the
 * replacement text, so an agent patching a template literal to
 * `$${props.price}` would silently get `${props.price}` written back. Every
 * substitution here is a plain slice-and-join.
 */

export interface ExactTextReplacement {
  oldText: string
  newText: string
  replaceAll?: boolean
}

export type ExactReplacementResult =
  | { ok: true; content: string; replaced: number }
  | { ok: false; reason: 'not-found' | 'ambiguous'; matches: number; replacement: ExactTextReplacement }

/** Non-overlapping occurrences of `search` in `content`; 0 for an empty search. */
export function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0
  let count = 0
  let index = content.indexOf(search)
  while (index !== -1) {
    count++
    index = content.indexOf(search, index + search.length)
  }
  return count
}

/**
 * Apply `replacements` in order. Each `oldText` must occur exactly once
 * unless `replaceAll` is set; the first miss or ambiguity aborts and reports
 * which replacement failed so the caller can name the file.
 */
export function applyExactReplacements(
  content: string,
  replacements: readonly ExactTextReplacement[],
): ExactReplacementResult {
  let next = content
  let replaced = 0
  for (const replacement of replacements) {
    const matches = countOccurrences(next, replacement.oldText)
    if (matches === 0) {
      return { ok: false, reason: 'not-found', matches, replacement }
    }
    if (matches > 1 && replacement.replaceAll !== true) {
      return { ok: false, reason: 'ambiguous', matches, replacement }
    }
    if (replacement.replaceAll === true) {
      next = next.split(replacement.oldText).join(replacement.newText)
      replaced += matches
    } else {
      const index = next.indexOf(replacement.oldText)
      next = next.slice(0, index) + replacement.newText + next.slice(index + replacement.oldText.length)
      replaced += 1
    }
  }
  return { ok: true, content: next, replaced }
}
