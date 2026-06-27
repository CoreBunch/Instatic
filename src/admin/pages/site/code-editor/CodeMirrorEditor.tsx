/**
 * CodeMirrorEditor — CodeMirror 6 editor mount.
 *
 * This module is LAZY-LOADED via React.lazy() in CodeEditorPanel — it MUST
 * NOT be imported statically from the editor main chunk. CodeMirror 6 adds
 * ~150 kB min+gz; code-splitting it behind React.lazy keeps the editor
 * startup bundle lean.
 *
 * Features:
 * - Per-type extension stacks (JSX/TS, CSS, JSON, Markdown, plain text).
 * - GitHub Dark-inspired CM6 theme using direct global design tokens CSS custom properties.
 * - Debounced 250ms content sync → updateFileContent() (Contribution #595 §3.3).
 * - Flush-on-switch: the useEffect cleanup flushes any pending edit before
 *   the view is destroyed, so unsaved edits survive file switches.
 *
 * Content sync pattern:
 *   Every CM6 doc change records the pending content in a ref. A 250ms debounce
 *   timer fires updateFileContent(). When the file switches (file.id changes),
 *   the old useEffect cleanup:
 *     1. Clears the debounce timer.
 *     2. Immediately flushes the pending content (flush-on-switch).
 *     3. Destroys the old CM6 view.
 *   The new effect creates a fresh view for the new file.
 *
 * @see CodeEditorPanel.tsx — parent (lazy-loads this module)
 * @see Contribution #595 §3 — architecture spec
 * @see globals.css — editor syntax palette and chrome design tokens
 * @see Constraint #402 — no inline styles
 */

import { useRef, useEffect, useEffectEvent, useCallback } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

// ---------------------------------------------------------------------------
// GitHub Dark-inspired CM6 theme — CSS custom properties only.
// ---------------------------------------------------------------------------
// All color values are CSS custom properties from globals.css.
// No hex, rgb(), or hsl() literals in this lazy-loaded editor module.
const achromatic = EditorView.theme({
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

const readableSyntaxHighlighting = syntaxHighlighting(readableHighlightStyle)

// ---------------------------------------------------------------------------
// Per-type extension stacks
// ---------------------------------------------------------------------------

/**
 * The set of languages the editor can syntax-highlight. Callers map their
 * source (a SiteFile's type/path, or an arbitrary code buffer like an inline
 * SVG prop) to one of these — keeping the CM6 language imports inside this
 * lazy-loaded chunk.
 */
export type CodeLanguage =
  | 'tsx'
  | 'ts'
  | 'css'
  | 'json'
  | 'markdown'
  | 'html'
  | 'text'

/** Map a `CodeLanguage` to its CM6 language extension(s). */
function getLanguageExtensions(language: CodeLanguage): Extension[] {
  switch (language) {
    case 'tsx':
      return [javascript({ jsx: true, typescript: true })]
    case 'ts':
      return [javascript({ typescript: true })]
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

// ---------------------------------------------------------------------------
// CodeMirrorEditor
// ---------------------------------------------------------------------------

interface CodeMirrorEditorProps {
  /**
   * Stable identity of the document being edited. Switching `docKey` tears
   * down and remounts the CM6 view (flushing the prior buffer first). For a
   * file this is the file id; for a node-prop buffer, `node:<id>:<prop>`.
   */
  docKey: string
  /** Initial document text (only read on mount / docKey change). */
  value: string
  /** Which language extensions to load for highlighting. */
  language: CodeLanguage
  /**
   * Debounced (250 ms) on every edit, and flushed immediately on docKey
   * switch. Optional for `readOnly` mounts — a viewer has nothing to report.
   */
  onChange?: (content: string) => void
  /**
   * Change propagation delay. File editors keep the 250 ms default; modal
   * command surfaces can pass 0 so their primary action never reads stale text.
   */
  changeDelayMs?: number
  /**
   * Read-only viewer mode — syntax-highlighted display with selection/copy
   * but no edits (SEO schema/robots previews, future log viewers). Skips the
   * update-listener plumbing entirely.
   */
  readOnly?: boolean
}

export default function CodeMirrorEditor({
  docKey,
  value,
  language,
  onChange,
  changeDelayMs = 250,
  readOnly = false,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Refs to hold pending debounce state. Using refs (not state) so that reads
  // inside the CM6 update listener always see the current values without
  // triggering re-renders.
  const pendingContentRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Always-current reference to onChange — avoids stale closure inside the CM6
  // updateListener while keeping the main useEffect dep-free.
  const onChangeRef = useRef(onChange ?? (() => {}))
  useEffect(() => {
    onChangeRef.current = onChange ?? (() => {})
  }, [onChange])

  // useCallback kept: stable identity for the [flush] useEffect dep array (exhaustive-deps).
  // Flush pending content to the store immediately (called on doc switch).
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (pendingContentRef.current !== null) {
      // Flush-on-switch: persist pending edit before unmounting.
      onChangeRef.current(pendingContentRef.current)
      pendingContentRef.current = null
    }
  }, [])

  // Mount/destroy CM6 view when docKey changes (document switch).
  //
  // The mount captures the latest value / language via useEffectEvent —
  // re-running on every keystroke would destroy + recreate the EditorView and
  // lose cursor position. The effect only re-runs on docKey transitions, and
  // the cleanup's `flush()` persists any pending edit captured at mount time.
  const mountView = useEffectEvent((container: HTMLDivElement) => {
    return new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          ...getLanguageExtensions(language),
          readableSyntaxHighlighting,
          achromatic,
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const content = update.state.doc.toString()
            if (changeDelayMs <= 0) {
              if (timerRef.current) {
                clearTimeout(timerRef.current)
                timerRef.current = null
              }
              pendingContentRef.current = null
              onChangeRef.current(content)
              return
            }
            pendingContentRef.current = content
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => {
              if (pendingContentRef.current !== null) {
                onChangeRef.current(pendingContentRef.current)
                pendingContentRef.current = null
              }
              timerRef.current = null
            }, changeDelayMs)
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: container,
    })
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const view = mountView(container)

    return () => {
      // Flush-on-switch: persist any pending edit before destroying this view.
      // This guarantees unsaved edits survive doc switches even if the
      // debounce timer has not fired yet.
      flush()
      view.destroy()
    }
  }, [docKey, flush])

  return (
    <div
      ref={containerRef}
      data-codemirror-container=""
    />
  )
}
