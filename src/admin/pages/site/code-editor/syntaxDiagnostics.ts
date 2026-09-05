/**
 * syntaxDiagnostics — lezer parse errors as CodeMirror lint diagnostics.
 *
 * Surfaces `⚠` error nodes of the active language grammar so a document
 * that is mid-edit (an unclosed block, a half-typed selector) shows an
 * inline marker, and lets the editor report the error count with each
 * change so live-applying callers can hold back until the text parses.
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import type { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import type { Diagnostic } from '@codemirror/lint'

/** Parsing budget per call, in ms — panel documents are small. */
const PARSE_TIMEOUT_MS = 100

export function syntaxDiagnostics(state: EditorState): Diagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT_MS)
  if (!tree) return []
  const diagnostics: Diagnostic[] = []
  tree.iterate({
    enter: (node) => {
      if (!node.type.isError) return
      diagnostics.push({
        from: node.from,
        to: Math.min(state.doc.length, Math.max(node.to, node.from + 1)),
        severity: 'error',
        message: 'Syntax error',
        source: 'Syntax',
      })
    },
  })
  return diagnostics
}
