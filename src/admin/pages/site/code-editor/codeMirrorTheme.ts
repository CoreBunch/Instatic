/**
 * codeMirrorTheme — the editor's CM6 theme + syntax highlight style.
 *
 * Part of the lazy CodeMirror chunk (imported only by CodeMirrorEditor.tsx —
 * see codemirror-lazy-only.test.ts). GitHub Dark-inspired; every color is a
 * CSS custom property from globals.css — no hex, rgb(), or hsl() literals.
 */
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export const editorTheme = EditorView.theme({
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

const readableHighlightStyle = HighlightStyle.define([
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

export const readableSyntaxHighlighting = syntaxHighlighting(readableHighlightStyle)
