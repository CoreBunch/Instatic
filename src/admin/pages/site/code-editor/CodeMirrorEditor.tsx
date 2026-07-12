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
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { hoverTooltip, tooltips, type Tooltip } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'
import {
  createTypeScriptLanguageClient,
  type TypeScriptLanguageClient,
} from './typescriptLanguageClient'
import type {
  TypeScriptEditorDiagnostic,
  TypeScriptProjectFile,
} from './typescriptProtocol'
import { renderMarkdownDocumentation } from './markdownDocumentation'

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
  | 'jsx'
  | 'javascript'
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
  /** Debounced (250 ms) on every edit, and flushed immediately on docKey switch. */
  onChange: (content: string) => void
  /**
   * Change propagation delay. File editors keep the 250 ms default; modal
   * command surfaces can pass 0 so their primary action never reads stale text.
   */
  changeDelayMs?: number
  /**
   * Extra CM6 extensions appended to the stack — the Plugin IDE passes the
   * yCollab binding (Y.Text sync + remote peer cursors) here. Captured at
   * mount like `value`/`language`; changing them mid-doc requires a docKey
   * change (which remounts the view).
   */
  extensions?: Extension[]
  /** Authoritative publisher-compiler diagnostics for this document. */
  diagnostics?: SiteRuntimeDiagnostic[]
  /** Site-relative path used by the TypeScript language-service project. */
  filePath?: string
  /** Other authored files available for relative imports and shared types. */
  projectFiles?: readonly { path: string; content?: string }[]
  /** Reports non-blocking semantic TypeScript diagnostics to the Problems panel. */
  onTypeScriptDiagnosticsChange?: (diagnostics: TypeScriptEditorDiagnostic[]) => void
}

const EMPTY_DIAGNOSTICS: SiteRuntimeDiagnostic[] = []

function codeMirrorDiagnostics(
  document: EditorState['doc'],
  diagnostics: SiteRuntimeDiagnostic[],
): Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const requestedLine = diagnostic.line ?? 1
    const lineNumber = Math.max(1, Math.min(requestedLine, document.lines))
    const line = document.line(lineNumber)
    // esbuild columns are zero-based; CodeMirror positions are absolute
    // offsets into the document.
    const column = Math.max(0, diagnostic.column ?? 0)
    const from = Math.min(line.to, line.from + column)
    return {
      from,
      to: Math.min(line.to, from + 1),
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: 'Instatic compiler',
    }
  })
}

function typeScriptCodeMirrorDiagnostics(
  document: EditorState['doc'],
  diagnostics: TypeScriptEditorDiagnostic[],
): Diagnostic[] {
  return diagnostics.map((diagnostic) => ({
    from: Math.max(0, Math.min(diagnostic.from, document.length)),
    to: Math.max(0, Math.min(diagnostic.to, document.length)),
    severity: diagnostic.severity,
    message: `TS${diagnostic.code}: ${diagnostic.message}`,
    source: 'TypeScript',
  }))
}

function dispatchCombinedDiagnostics(
  view: EditorView,
  runtimeDiagnostics: SiteRuntimeDiagnostic[],
  typeScriptDiagnostics: TypeScriptEditorDiagnostic[],
): void {
  view.dispatch(setDiagnostics(view.state, [
    ...codeMirrorDiagnostics(view.state.doc, runtimeDiagnostics),
    ...typeScriptCodeMirrorDiagnostics(view.state.doc, typeScriptDiagnostics),
  ]))
}

function isTypeScriptLanguage(language: CodeLanguage): boolean {
  return language === 'ts' || language === 'tsx'
}

/** Keep completion and hover popups inside the visible editor surface. */
const editorTooltipBoundary = tooltips({
  tooltipSpace: (view) => view.dom.getBoundingClientRect(),
})

function typeScriptProject(
  files: readonly { path: string; content?: string }[],
  activePath: string,
  activeContent: string,
): TypeScriptProjectFile[] {
  const project = files.flatMap((file) => (
    typeof file.content === 'string' && /\.(?:[cm]?ts|tsx)$/.test(file.path)
      ? [{ path: file.path, content: file.path === activePath ? activeContent : file.content }]
      : []
  ))
  if (!project.some((file) => file.path === activePath)) {
    project.push({ path: activePath, content: activeContent })
  }
  return project
}

function typeScriptCompletionSource(
  client: TypeScriptLanguageClient,
  filePath: string,
) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const word = context.matchBefore(/[\w$]*/)
    if (!context.explicit && (!word || (word.from === word.to && context.pos === 0))) return null
    client.updateFile(filePath, context.state.doc.toString())
    try {
      const result = await client.completions(filePath, context.pos)
      if (!result) return null
      const from = Math.max(0, Math.min(result.from, context.state.doc.length))
      const to = Math.max(from, Math.min(result.to, context.state.doc.length))
      return {
        from,
        to,
        options: result.options,
      }
    } catch (error) {
      console.warn('[CodeMirrorEditor] TypeScript completions unavailable:', error)
      return null
    }
  }
}

function typeScriptHoverSource(
  client: TypeScriptLanguageClient,
  filePath: string,
) {
  return async (view: EditorView, position: number): Promise<Tooltip | null> => {
    client.updateFile(filePath, view.state.doc.toString())
    try {
      const result = await client.hover(filePath, position)
      if (!result) return null
      return {
        pos: Math.max(0, Math.min(result.from, view.state.doc.length)),
        end: Math.max(0, Math.min(result.to, view.state.doc.length)),
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-typescript-hover'

          const signature = document.createElement('div')
          signature.className = 'cm-typescript-hover-signature'
          signature.textContent = result.signature
          dom.append(signature)

          if (result.documentation) {
            const documentation = document.createElement('div')
            documentation.className = 'cm-typescript-hover-documentation'
            renderMarkdownDocumentation(documentation, result.documentation)
            dom.append(documentation)
          }
          return { dom }
        },
      }
    } catch (error) {
      console.warn('[CodeMirrorEditor] TypeScript hover unavailable:', error)
      return null
    }
  }
}

export default function CodeMirrorEditor({
  docKey,
  value,
  language,
  onChange,
  changeDelayMs = 250,
  diagnostics = EMPTY_DIAGNOSTICS,
  filePath,
  projectFiles = EMPTY_PROJECT_FILES,
  onTypeScriptDiagnosticsChange,
  extensions,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const typeScriptClientRef = useRef<TypeScriptLanguageClient | null>(null)
  const typeScriptDiagnosticsRef = useRef<TypeScriptEditorDiagnostic[]>([])
  const runtimeDiagnosticsRef = useRef<SiteRuntimeDiagnostic[]>(diagnostics)
  const refreshTypeScriptDiagnosticsRef = useRef<(() => void) | null>(null)

  // Refs to hold pending debounce state. Using refs (not state) so that reads
  // inside the CM6 update listener always see the current values without
  // triggering re-renders.
  const pendingContentRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Always-current reference to onChange — avoids stale closure inside the CM6
  // updateListener while keeping the main useEffect dep-free.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const onTypeScriptDiagnosticsChangeRef = useRef(onTypeScriptDiagnosticsChange)
  useEffect(() => {
    onTypeScriptDiagnosticsChangeRef.current = onTypeScriptDiagnosticsChange
  }, [onTypeScriptDiagnosticsChange])

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
    const typeScriptClient = filePath && isTypeScriptLanguage(language)
      ? createTypeScriptLanguageClient()
      : null
    typeScriptClientRef.current = typeScriptClient
    if (typeScriptClient && filePath) {
      typeScriptClient.syncProject(typeScriptProject(projectFiles, filePath, value))
    }

    let typeScriptDiagnosticsTimer: ReturnType<typeof setTimeout> | null = null
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          ...getLanguageExtensions(language),
          ...(typeScriptClient && filePath
            ? [
                autocompletion({ override: [typeScriptCompletionSource(typeScriptClient, filePath)] }),
                hoverTooltip(typeScriptHoverSource(typeScriptClient, filePath)),
              ]
            : []),
          readableSyntaxHighlighting,
          achromatic,
          editorTooltipBoundary,
          lintGutter(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const content = update.state.doc.toString()
            if (typeScriptClient && filePath) {
              typeScriptClient.updateFile(filePath, content)
              if (typeScriptDiagnosticsTimer) clearTimeout(typeScriptDiagnosticsTimer)
              typeScriptDiagnosticsTimer = setTimeout(() => {
                refreshTypeScriptDiagnosticsRef.current?.()
                typeScriptDiagnosticsTimer = null
              }, 300)
            }
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
          ...(extensions ?? []),
        ],
      }),
      parent: container,
    })

    if (typeScriptClient && filePath) {
      refreshTypeScriptDiagnosticsRef.current = () => {
        const activeClient = typeScriptClientRef.current
        const activeView = viewRef.current
        if (activeClient !== typeScriptClient || activeView !== view) return
        void typeScriptClient.diagnostics(filePath)
          .then((nextDiagnostics) => {
            if (typeScriptClientRef.current !== typeScriptClient || viewRef.current !== view) return
            typeScriptDiagnosticsRef.current = nextDiagnostics
            dispatchCombinedDiagnostics(
              view,
              runtimeDiagnosticsRef.current,
              nextDiagnostics,
            )
            onTypeScriptDiagnosticsChangeRef.current?.(nextDiagnostics)
          })
          .catch((error) => {
            if (typeScriptClientRef.current !== typeScriptClient) return
            console.error('[CodeMirrorEditor] TypeScript diagnostics unavailable:', error)
            typeScriptDiagnosticsRef.current = []
            dispatchCombinedDiagnostics(view, runtimeDiagnosticsRef.current, [])
            onTypeScriptDiagnosticsChangeRef.current?.([])
          })
      }
    }

    return {
      view,
      dispose: () => {
        if (typeScriptDiagnosticsTimer) clearTimeout(typeScriptDiagnosticsTimer)
        typeScriptClient?.dispose()
      },
    }
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const mounted = mountView(container)
    const view = mounted.view
    viewRef.current = view
    refreshTypeScriptDiagnosticsRef.current?.()

    return () => {
      // Flush-on-switch: persist any pending edit before destroying this view.
      // This guarantees unsaved edits survive doc switches even if the
      // debounce timer has not fired yet.
      flush()
      viewRef.current = null
      typeScriptClientRef.current = null
      refreshTypeScriptDiagnosticsRef.current = null
      typeScriptDiagnosticsRef.current = []
      onTypeScriptDiagnosticsChangeRef.current?.([])
      mounted.dispose()
      view.destroy()
    }
  }, [docKey, flush])

  useEffect(() => {
    const client = typeScriptClientRef.current
    const view = viewRef.current
    if (!client || !view || !filePath || !isTypeScriptLanguage(language)) return
    client.syncProject(typeScriptProject(
      projectFiles,
      filePath,
      view.state.doc.toString(),
    ))
    refreshTypeScriptDiagnosticsRef.current?.()
  }, [filePath, language, projectFiles])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    runtimeDiagnosticsRef.current = diagnostics
    dispatchCombinedDiagnostics(view, diagnostics, typeScriptDiagnosticsRef.current)
  }, [diagnostics, docKey])

  return (
    <div
      ref={containerRef}
      data-codemirror-container=""
    />
  )
}

const EMPTY_PROJECT_FILES: readonly { path: string; content?: string }[] = []
