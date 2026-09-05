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

import { useRef, useEffect, useEffectEvent, useCallback, useImperativeHandle, type Ref } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Annotation, EditorState, Prec } from '@codemirror/state'
import {
  acceptCompletion,
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { hoverTooltip, keymap, tooltips, type Tooltip } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
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
import { editorTheme, readableSyntaxHighlighting } from './codeMirrorTheme'
import { foldLockedRanges, lockedRegions, type LockedRange } from './lockedRegions'
import { uidAttributes } from './uidAttributes'
import { syntaxDiagnostics } from './syntaxDiagnostics'
import { contextCompletions } from './contextCompletions'
import { uidInspector } from './uidInspector'
import { cssVarShorthand } from './cssVarShorthand'
import { documentChanges } from './documentDiff'
import { formatDocument, isFormattableLanguage, type FormatResult } from './formatDocument'
import type { EditorCompletionCatalog } from './completionCatalog'

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
  onChange: (content: string, info: EditorChangeInfo) => void
  /**
   * Change propagation delay. File editors keep the 250 ms default; modal
   * command surfaces can pass 0 so their primary action never reads stale text.
   */
  changeDelayMs?: number
  /** Authoritative publisher-compiler diagnostics for this document. */
  diagnostics?: SiteRuntimeDiagnostic[]
  /** Site-relative path used by the TypeScript language-service project. */
  filePath?: string
  /** Other authored files available for relative imports and shared types. */
  projectFiles?: readonly { path: string; content?: string }[]
  /** Reports non-blocking semantic TypeScript diagnostics to the Problems panel. */
  onTypeScriptDiagnosticsChange?: (diagnostics: TypeScriptEditorDiagnostic[]) => void
  /**
   * Surface the language grammar's parse errors as inline diagnostics and
   * report their count with every change, so a live-applying caller can hold
   * back while the document is mid-edit.
   */
  lintSyntax?: boolean
  /**
   * Read-only ranges of the INITIAL document (folded on mount, edits inside
   * them rejected). They follow edits made above them.
   */
  lockedRanges?: readonly LockedRange[]
  /** View-only document: every change is rejected and the surface is not editable. */
  readOnly?: boolean
  /**
   * Show every `uid="…"` attribute as a clickable Instatic mark instead of
   * text (click reveals the uid, click again hides it). The text stays in
   * the document. For the God Mode HTML projection.
   */
  foldUidAttributes?: boolean
  /** Mod-Enter: the pending text is flushed to `onChange`, then this runs. */
  onSubmit?: () => void
  /**
   * Context the document is edited in — class names, published-site custom
   * properties, dynamic-token schemas, page classes/ids — turned into
   * completion sources appended to the language's defaults (language data,
   * so the TypeScript language-service override above ignores it). Read
   * live: a new catalog takes effect on the next completion, no remount.
   */
  completions?: EditorCompletionCatalog
  /**
   * Reports the `uid` of the element whose markup the cursor is in as it
   * changes (null for uid-less content, or when the editor loses focus).
   * For the God Mode HTML projection's reverse selection sync.
   */
  onCursorUid?: (uid: string | null) => void
  /** Reports the `uid` of the element whose tag name was clicked. */
  onTagClick?: (uid: string) => void
  /**
   * Follow `value` while mounted: when it changes for the same `docKey`,
   * the buffer is patched IN PLACE with the minimal line edits (caret,
   * history and folds survive) instead of ignoring it. Skipped while an
   * edit is still pending, which would be overwritten by the flush anyway.
   * Such patches never re-enter `onChange`.
   */
  syncValue?: boolean
  /** Show the lint marker gutter column (diagnostics stay inline without it). */
  lintGutter?: boolean
  /** Formatting (Shift-Alt-F or `format()`) failed — e.g. the document does not parse. */
  onFormatError?: (message: string) => void
  ref?: Ref<CodeMirrorEditorHandle>
}

export interface CodeMirrorEditorHandle {
  /** Format the document with Prettier; resolves once the buffer is updated. */
  format: () => Promise<FormatResult>
}

/** Marks a transaction that brings the buffer up to date with `value` — not an author edit. */
const valueSync = Annotation.define<boolean>()

const rejectAllChanges = EditorState.changeFilter.of(() => false)
const readOnlyExtensions = [EditorState.readOnly.of(true), EditorView.editable.of(false), rejectAllChanges]

export interface EditorChangeInfo {
  /** Parser error count at the time of the change (always 0 unless `lintSyntax`). */
  syntaxErrorCount: number
}

export type { LockedRange } from './lockedRegions'

const EMPTY_LOCKED_RANGES: readonly LockedRange[] = []
const EMPTY_SYNTAX_DIAGNOSTICS: Diagnostic[] = []

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
  syntax: Diagnostic[],
): void {
  view.dispatch(setDiagnostics(view.state, [
    ...codeMirrorDiagnostics(view.state.doc, runtimeDiagnostics),
    ...typeScriptCodeMirrorDiagnostics(view.state.doc, typeScriptDiagnostics),
    ...syntax,
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
  lintSyntax = false,
  lockedRanges = EMPTY_LOCKED_RANGES,
  readOnly = false,
  foldUidAttributes = false,
  onSubmit,
  completions,
  onCursorUid,
  onTagClick,
  syncValue = false,
  lintGutter: showLintGutter = true,
  onFormatError,
  ref,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const typeScriptClientRef = useRef<TypeScriptLanguageClient | null>(null)
  const typeScriptDiagnosticsRef = useRef<TypeScriptEditorDiagnostic[]>([])
  const runtimeDiagnosticsRef = useRef<SiteRuntimeDiagnostic[]>(diagnostics)
  const syntaxDiagnosticsRef = useRef<Diagnostic[]>(EMPTY_SYNTAX_DIAGNOSTICS)
  const refreshTypeScriptDiagnosticsRef = useRef<(() => void) | null>(null)

  // Refs to hold pending debounce state. Using refs (not state) so that reads
  // inside the CM6 update listener always see the current values without
  // triggering re-renders.
  const pendingChangeRef = useRef<{ content: string; info: EditorChangeInfo } | null>(null)
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
  const onSubmitRef = useRef(onSubmit)
  useEffect(() => {
    onSubmitRef.current = onSubmit
  }, [onSubmit])
  const completionsRef = useRef(completions)
  useEffect(() => {
    completionsRef.current = completions
  }, [completions])
  const getCompletions = () => completionsRef.current ?? null
  const onCursorUidRef = useRef(onCursorUid)
  const onTagClickRef = useRef(onTagClick)
  useEffect(() => {
    onCursorUidRef.current = onCursorUid
    onTagClickRef.current = onTagClick
  }, [onCursorUid, onTagClick])
  const inspectorHandlers = () => ({
    onCursorUid: (uid: string | null) => onCursorUidRef.current?.(uid),
    onTagClick: (uid: string) => onTagClickRef.current?.(uid),
  })
  const onFormatErrorRef = useRef(onFormatError)
  useEffect(() => {
    onFormatErrorRef.current = onFormatError
  }, [onFormatError])

  const format = async (): Promise<FormatResult> => {
    const view = viewRef.current
    if (!view) return { ok: false, error: 'No document is open' }
    if (!isFormattableLanguage(language)) return { ok: false, error: 'This document type cannot be formatted' }
    const result = await formatDocument(view, language)
    if (!result.ok) onFormatErrorRef.current?.(result.error)
    return result
  }
  const formatRef = useRef(format)
  useEffect(() => {
    formatRef.current = format
  })
  useImperativeHandle(ref, () => ({ format: () => formatRef.current() }), [])

  // useCallback kept: stable identity for the [flush] useEffect dep array (exhaustive-deps).
  // Flush pending content to the store immediately (called on doc switch).
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (pendingChangeRef.current !== null) {
      // Flush-on-switch: persist pending edit before unmounting.
      const { content, info } = pendingChangeRef.current
      pendingChangeRef.current = null
      onChangeRef.current(content, info)
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
          // Ahead of basicSetup so Mod-Enter wins over the default Enter
          // binding, Tab accepts an open completion, and Shift-Alt-F formats.
          Prec.high(keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                if (!onSubmitRef.current) return false
                flush()
                onSubmitRef.current()
                return true
              },
            },
            { key: 'Tab', run: acceptCompletion },
            {
              key: 'Shift-Alt-f',
              run: () => {
                void formatRef.current()
                return true
              },
            },
          ])),
          basicSetup,
          ...getLanguageExtensions(language),
          ...(typeScriptClient && filePath
            ? [
                autocompletion({ override: [typeScriptCompletionSource(typeScriptClient, filePath)] }),
                hoverTooltip(typeScriptHoverSource(typeScriptClient, filePath)),
              ]
            : []),
          ...(completions ? [contextCompletions(getCompletions)] : []),
          ...(onCursorUid || onTagClick ? [uidInspector(inspectorHandlers)] : []),
          ...(language === 'css' ? [cssVarShorthand()] : []),
          readableSyntaxHighlighting,
          editorTheme,
          ...(lockedRanges.length > 0 ? [lockedRegions(lockedRanges)] : []),
          ...(readOnly ? readOnlyExtensions : []),
          ...(foldUidAttributes ? [uidAttributes()] : []),
          editorTooltipBoundary,
          ...(showLintGutter ? [lintGutter()] : []),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const synced = update.transactions.every((tr) => tr.annotation(valueSync) === true)
            const content = update.state.doc.toString()
            if (typeScriptClient && filePath) {
              typeScriptClient.updateFile(filePath, content)
              if (typeScriptDiagnosticsTimer) clearTimeout(typeScriptDiagnosticsTimer)
              typeScriptDiagnosticsTimer = setTimeout(() => {
                refreshTypeScriptDiagnosticsRef.current?.()
                typeScriptDiagnosticsTimer = null
              }, 300)
            }
            const syntax = lintSyntax ? syntaxDiagnostics(update.state) : EMPTY_SYNTAX_DIAGNOSTICS
            if (lintSyntax) {
              syntaxDiagnosticsRef.current = syntax
              // Nested dispatches are not allowed from an update listener.
              queueMicrotask(() => {
                if (viewRef.current !== view) return
                dispatchCombinedDiagnostics(
                  view,
                  runtimeDiagnosticsRef.current,
                  typeScriptDiagnosticsRef.current,
                  syntaxDiagnosticsRef.current,
                )
              })
            }
            // A value sync is the parent's own text arriving; it is not an
            // edit to report back.
            if (synced) return
            const info: EditorChangeInfo = { syntaxErrorCount: syntax.length }
            if (changeDelayMs <= 0) {
              if (timerRef.current) {
                clearTimeout(timerRef.current)
                timerRef.current = null
              }
              pendingChangeRef.current = null
              onChangeRef.current(content, info)
              return
            }
            pendingChangeRef.current = { content, info }
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => {
              if (pendingChangeRef.current !== null) {
                const pending = pendingChangeRef.current
                pendingChangeRef.current = null
                onChangeRef.current(pending.content, pending.info)
              }
              timerRef.current = null
            }, changeDelayMs)
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: container,
    })
    if (lockedRanges.length > 0) foldLockedRanges(view, lockedRanges)
    syntaxDiagnosticsRef.current = lintSyntax ? syntaxDiagnostics(view.state) : EMPTY_SYNTAX_DIAGNOSTICS

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
              syntaxDiagnosticsRef.current,
            )
            onTypeScriptDiagnosticsChangeRef.current?.(nextDiagnostics)
          })
          .catch((error) => {
            if (typeScriptClientRef.current !== typeScriptClient) return
            console.error('[CodeMirrorEditor] TypeScript diagnostics unavailable:', error)
            typeScriptDiagnosticsRef.current = []
            dispatchCombinedDiagnostics(view, runtimeDiagnosticsRef.current, [], syntaxDiagnosticsRef.current)
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
    if (!syncValue) return
    const view = viewRef.current
    if (!view || pendingChangeRef.current !== null) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: documentChanges(current, value), annotations: [valueSync.of(true)] })
  }, [value, syncValue])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    runtimeDiagnosticsRef.current = diagnostics
    dispatchCombinedDiagnostics(view, diagnostics, typeScriptDiagnosticsRef.current, syntaxDiagnosticsRef.current)
  }, [diagnostics, docKey])

  return (
    <div
      ref={containerRef}
      data-codemirror-container=""
    />
  )
}

const EMPTY_PROJECT_FILES: readonly { path: string; content?: string }[] = []
