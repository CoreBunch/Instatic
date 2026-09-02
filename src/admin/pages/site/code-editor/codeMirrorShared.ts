/**
 * Shared CodeMirror pieces — the editor chrome theme, the readable syntax
 * highlight style, and the per-language extension stacks. Consumed by the
 * editable editor (CodeMirrorEditor), the collab variant, and the agent
 * panel's read-only code/diff viewer (AgentCodeView). Lives in its own
 * non-component module so component files keep react-refresh eligibility.
 *
 * This module imports CodeMirror packages and is therefore part of the
 * lazy-loaded editor chunk graph — listed in the codemirror-lazy-only gate.
 */
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import {
  HighlightStyle,
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { tags as t } from '@lezer/highlight'

/**
 * The editor's base extension stack — `codemirror`'s `basicSetup`, spelled
 * out so the LOCAL undo history can be left out.
 *
 * The co-edited buffer must not carry CodeMirror's own `history()`: the
 * Yjs binding dispatches remote peers' deltas as ordinary transactions,
 * `history()` records them as undoable steps, and Cmd+Z would revert a
 * peer's typing — then broadcast the revert. That buffer gets its undo from
 * `Y.UndoManager` through y-codemirror's keymap instead, which only ever
 * tracks local origins. Everything else (gutters, folding, brackets,
 * completion, search) is identical between the two editors.
 */
export function editingSetup(options: { localHistory: boolean }): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    ...(options.localHistory ? [history()] : []),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...(options.localHistory ? historyKeymap : []),
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
  ]
}


// ---------------------------------------------------------------------------
// GitHub Dark-inspired CM6 theme — CSS custom properties only.
// ---------------------------------------------------------------------------
// All color values are CSS custom properties from globals.css.
// No hex, rgb(), or hsl() literals in this lazy-loaded editor module.
export const editorChromeTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-surface)',
    color: 'var(--text)',
    height: '100%',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    caretColor: 'var(--overlay)',
    padding: 'var(--space-s) 0',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--overlay)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--overlay-10)',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--overlay-10)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-surface-3)',
    borderRight: '1px solid var(--overlay-10)',
    color: 'var(--text-disabled)',
  },
  '.cm-gutter': {
    minWidth: '3ch',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    color: 'var(--text-disabled)',
    fontSize: '11px',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-subtle)',
  },
  '.cm-line': {
    padding: '0 var(--space-l) 0 var(--space-3xs)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-surface-2)',
    border: '1px solid var(--overlay-10)',
    color: 'var(--text)',
  },
  '.cm-typescript-hover': {
    maxWidth: 'min(340px, calc(100vw - 32px))',
    padding: 'var(--space-s) var(--space-m)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    lineHeight: '1.5',
    overflowWrap: 'anywhere',
  },
  '.cm-typescript-hover-signature': {
    color: 'var(--syntax-entity)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-typescript-hover-documentation': {
    marginTop: 'var(--space-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-typescript-hover-documentation p': {
    margin: '0',
  },
  '.cm-typescript-hover-documentation p + p': {
    marginTop: 'var(--space-xs)',
  },
  '.cm-typescript-hover-documentation strong': {
    color: 'var(--text)',
    fontWeight: '600',
  },
  '.cm-typescript-hover-documentation code': {
    padding: '0 var(--space-3xs)',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--overlay-10)',
    color: 'var(--syntax-string)',
    fontFamily: 'var(--font-mono)',
  },
  '.cm-typescript-hover-documentation a': {
    color: 'var(--syntax-constant)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  '.cm-lintRange-error': {
    textDecorationColor: 'var(--danger)',
  },
  '.cm-lint-marker-error': {
    color: 'var(--danger)',
  },
}, { dark: true })

export const readableHighlightStyle = HighlightStyle.define([
  {
    tag: [
      t.comment,
      t.lineComment,
      t.blockComment,
      t.docComment,
      t.meta,
    ],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [
      t.keyword,
      t.definitionKeyword,
      t.operatorKeyword,
      t.modifier,
      t.controlKeyword,
    ],
    color: 'var(--syntax-keyword)',
    fontWeight: '600',
  },
  {
    tag: [
      t.labelName,
      t.typeName,
      t.className,
      t.namespace,
      t.macroName,
      t.tagName,
      t.function(t.variableName),
      t.function(t.propertyName),
    ],
    color: 'var(--syntax-entity)',
  },
  {
    tag: [
      t.propertyName,
      t.definition(t.propertyName),
      t.attributeName,
    ],
    color: 'var(--syntax-property)',
  },
  {
    tag: [
      t.variableName,
      t.definition(t.variableName),
      t.local(t.variableName),
      t.special(t.variableName),
    ],
    color: 'var(--syntax-variable)',
  },
  {
    tag: [
      t.atom,
      t.bool,
      t.number,
      t.integer,
      t.float,
      t.unit,
      t.color,
      t.url,
      t.literal,
      t.contentSeparator,
    ],
    color: 'var(--syntax-constant)',
  },
  {
    tag: [
      t.string,
      t.regexp,
      t.escape,
      t.special(t.string),
      t.inserted,
      t.deleted,
    ],
    color: 'var(--syntax-string)',
  },
  {
    tag: [
      t.operator,
      t.arithmeticOperator,
      t.logicOperator,
      t.compareOperator,
      t.definitionOperator,
      t.derefOperator,
      t.punctuation,
      t.separator,
      t.bracket,
      t.paren,
      t.squareBracket,
      t.brace,
    ],
    color: 'var(--syntax-operator)',
  },
  {
    tag: [t.heading, t.strong],
    color: 'var(--syntax-entity)',
    fontWeight: '700',
  },
  {
    tag: [t.emphasis],
    color: 'var(--syntax-string)',
    fontStyle: 'italic',
  },
  {
    tag: [t.link],
    color: 'var(--syntax-constant)',
    textDecoration: 'underline',
  },
  {
    tag: t.invalid,
    color: 'var(--syntax-invalid)',
  },
], { themeType: 'dark' })

/**
 * The set of languages the editor can syntax-highlight. Callers map their
 * source (a SiteFile's type/path, or an arbitrary code buffer like an inline
 * SVG prop) to one of these — keeping the CM6 language imports inside this
 * lazy-loaded chunk.
 */
export type CodeLanguage =
  | 'tsx'
  | 'ts'
  | 'jsx'
  | 'javascript'
  | 'css'
  | 'json'
  | 'markdown'
  | 'html'
  | 'text'

/** Map a `CodeLanguage` to its CM6 language extension(s). Shared with the
 * read-only agent code/diff views (`AgentCodeView.tsx`, same lazy graph). */
export function getLanguageExtensions(language: CodeLanguage): Extension[] {
  switch (language) {
    case 'tsx':
      return [javascript({ jsx: true, typescript: true })]
    case 'ts':
      return [javascript({ typescript: true })]
    case 'jsx':
      return [javascript({ jsx: true })]
    case 'javascript':
      return [javascript()]
    case 'css':
      return [css()]
    case 'json':
      return [json()]
    case 'markdown':
      return [markdown()]
    case 'html':
      // Used for inline SVG markup (SVG is HTML-compatible XML).
      return [html()]
    case 'text':
    default:
      return []
  }
}
