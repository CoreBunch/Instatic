/**
 * formatDocument — format an editor buffer with Prettier (the way an IDE's
 * "Format document" does), keeping the caret where Prettier maps it.
 *
 * Prettier and its language plugins are loaded on demand, in their own
 * chunks, the first time a document is formatted: nothing about the editor
 * pays for them until then. The change is dispatched as an ordinary edit
 * (one undo step), so a panel that applies live sees the formatted text.
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import type { EditorView } from '@codemirror/view'
import type { Options, Plugin } from 'prettier'
import { getErrorMessage } from '@core/utils/errorMessage'
import { documentChanges } from './documentDiff'

/** The languages Prettier can format here (`CodeLanguage` minus `text`). */
export type FormattableLanguage = 'tsx' | 'ts' | 'jsx' | 'javascript' | 'css' | 'json' | 'markdown' | 'html'

export type FormatResult = { ok: true } | { ok: false; error: string }

interface PrettierSetup {
  parser: string
  plugins: () => Promise<Plugin[]>
  options: Options
}

const plugin = async (load: Promise<{ default?: Plugin } | Plugin>): Promise<Plugin> => {
  const module = await load
  return 'default' in module && module.default ? module.default : (module as Plugin)
}

const estree = () => plugin(import('prettier/plugins/estree'))

/** The repo's own style for code: no semicolons, single quotes, 100 columns. */
const SCRIPT_OPTIONS: Options = { semi: false, singleQuote: true, printWidth: 100 }

const babel = () => plugin(import('prettier/plugins/babel'))
const typescript = () => plugin(import('prettier/plugins/typescript'))

/** A script language: its syntax plugin plus the shared estree printer. */
function scriptSetup(parser: 'babel' | 'typescript' | 'json', syntax: () => Promise<Plugin>, options: Options): PrettierSetup {
  return { parser, plugins: async () => [await syntax(), await estree()], options }
}

const SETUPS: Record<FormattableLanguage, PrettierSetup> = {
  html: {
    parser: 'html',
    plugins: async () => [await plugin(import('prettier/plugins/html'))],
    options: { printWidth: 100 },
  },
  css: {
    parser: 'css',
    plugins: async () => [await plugin(import('prettier/plugins/postcss'))],
    options: {},
  },
  javascript: scriptSetup('babel', babel, SCRIPT_OPTIONS),
  jsx: scriptSetup('babel', babel, SCRIPT_OPTIONS),
  ts: scriptSetup('typescript', typescript, SCRIPT_OPTIONS),
  tsx: scriptSetup('typescript', typescript, SCRIPT_OPTIONS),
  json: scriptSetup('json', babel, {}),
  markdown: {
    parser: 'markdown',
    plugins: async () => [await plugin(import('prettier/plugins/markdown'))],
    options: {},
  },
}

export function isFormattableLanguage(language: string): language is FormattableLanguage {
  return language in SETUPS
}

export async function formatDocument(view: EditorView, language: FormattableLanguage): Promise<FormatResult> {
  const setup = SETUPS[language]
  const source = view.state.doc.toString()
  const cursorOffset = view.state.selection.main.head
  try {
    const [prettier, plugins] = await Promise.all([import('prettier/standalone'), setup.plugins()])
    const result = await prettier.formatWithCursor(source, {
      ...setup.options,
      parser: setup.parser,
      plugins,
      cursorOffset,
    })
    // The buffer may have moved on while Prettier ran; only a still-current
    // source is safe to patch.
    if (view.state.doc.toString() !== source) return { ok: false, error: 'The document changed while formatting' }
    if (result.formatted !== source) {
      view.dispatch({
        changes: documentChanges(source, result.formatted),
        selection: { anchor: Math.max(0, Math.min(result.cursorOffset, result.formatted.length)) },
        scrollIntoView: true,
      })
    }
    return { ok: true }
  } catch (err) {
    // Usually the parser rejecting a document mid-edit: reported to the
    // caller (a toast), logged for the trace.
    console.warn('[formatDocument] formatting failed:', err)
    return { ok: false, error: getErrorMessage(err, 'Formatting failed') }
  }
}
