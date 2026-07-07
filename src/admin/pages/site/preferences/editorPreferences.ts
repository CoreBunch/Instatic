/**
 * Editor preferences — runtime read/write for the catalog of local UI prefs.
 *
 * The schema, defaults, and the live React hook are all derived from the
 * declarative `PREFERENCE_CATALOG` (see `./catalog.ts`). Adding a new
 * preference is a single catalog entry — this file does not need to change.
 *
 * Reactivity model
 * ----------------
 * Two layers:
 *   1. `subscribeToEditorPrefsChanged()` — low-level event bus used by
 *      non-React consumers (e.g. `usePersistence.ts`'s scheduler) that need to
 *      react to changes imperatively.
 *   2. `useEditorPreference(id)` — React hook that reads a value, subscribes
 *      to the bus, and re-renders when the value changes. This is the
 *      preferred path for components.
 *
 * Cross-tab updates: the `storage` event re-fires our local listeners so
 * editors open in two tabs stay in sync.
 */

import { Type, type Static } from '@sinclair/typebox'
import { useEffect, useState } from 'react'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import {
  PREFERENCE_CATALOG,
  defaultBooleanFor,
  defaultSelectFor,
  type BooleanPreferenceId,
  type SelectPreferenceId,
} from './catalog'

export const EDITOR_PREFS_KEY = 'instatic-editor-prefs'

interface EditorAppearancePreferences {
  density: string
  theme: string
  textScale: string
}

// ---------------------------------------------------------------------------
// Schema and defaults — derived from the catalog
//
// Every catalog entry contributes one optional field to the schema (we accept
// missing fields so older snapshots don't crash newer readers) and one entry
// in DEFAULT_EDITOR_PREFS. `additionalProperties: true` keeps the door open
// for fields written by future builds without rejecting them on parse.
// ---------------------------------------------------------------------------

const schemaFields: Record<string, ReturnType<typeof Type.Optional>> = {}
for (const def of PREFERENCE_CATALOG) {
  if (def.type === 'boolean') {
    schemaFields[def.id] = Type.Optional(Type.Boolean())
  } else if (def.type === 'select' || def.type === 'select-dynamic') {
    schemaFields[def.id] = Type.Optional(Type.String())
  }
}

const EditorPrefsSchema = Type.Object(schemaFields, {
  additionalProperties: true,
})

type EditorPrefs = Static<typeof EditorPrefsSchema>

const DEFAULT_EDITOR_PREFS: Required<EditorPrefs> = (() => {
  const acc: Record<string, boolean | string> = {}
  for (const def of PREFERENCE_CATALOG) {
    if (def.type === 'boolean') acc[def.id] = def.default
    else if (def.type === 'select' || def.type === 'select-dynamic') {
      acc[def.id] = def.default
    }
  }
  return acc as Required<EditorPrefs>
})()

// ---------------------------------------------------------------------------
// Storage IO + in-memory cache
//
// `readEditorPrefs` is called on every preference read (auto-save scheduler
// tick, every `useEditorPreference` mount, every command-palette telemetry
// fan-out, etc.). The dominant per-read cost is `JSON.parse` + TypeBox
// validation (~0.5 ms), not `localStorage.getItem` itself. We cache the
// PARSED snapshot alongside the raw string it was parsed from. Every read
// still does a fast `localStorage.getItem` and compares raw strings: a
// match returns the cached object (no JSON.parse, no TypeBox); a mismatch
// re-parses.
//
// Why compare the raw string instead of just trusting a write-through cache?
//   - Tests and `localStorage.clear()` mutate storage without going through
//     `writeEditorPrefs`. The raw-string check picks those changes up on
//     the next read.
//   - Cross-tab updates fire a `storage` event; the listener clears the
//     cache so subscribers re-read fresh.
//   - The subscription path is centralised through `notifySubscribers`
//     ("invalidate, then notify") so listeners never observe a stale cache
//     after a change event.
//
// SSR / non-browser callers (architecture tests, etc.) just see a cold read
// every time because `globalThis.window` is undefined.
// ---------------------------------------------------------------------------

interface CachedPrefsEntry {
  /** Raw string read from `localStorage`, or `null` if storage was empty. */
  raw: string | null
  /** Parsed snapshot. Shared by reference across reads — never mutated. */
  prefs: EditorPrefs
}

let cachedPrefsEntry: CachedPrefsEntry | undefined

/** Subscribers registered via `subscribeToEditorPrefsChanged`. */
const prefsChangeSubscribers = new Set<() => void>()

/**
 * Once-per-load wiring of the cross-tab storage listener. Lazy so SSR /
 * test environments without `window` don't crash on module load.
 */
let storageListenerWired = false
function ensureStorageListenerWired(): void {
  if (storageListenerWired) return
  const win = globalThis.window
  if (!win) return
  storageListenerWired = true
  win.addEventListener('storage', (event) => {
    if (event.key !== EDITOR_PREFS_KEY) return
    // Invalidate FIRST so subscribers re-read fresh data.
    cachedPrefsEntry = undefined
    notifySubscribers()
  })
}

function notifySubscribers(): void {
  for (const listener of prefsChangeSubscribers) {
    try {
      listener()
    } catch (err) {
      // One bad subscriber must not break the rest.
      console.error('[editor-preferences] subscriber threw:', err)
    }
  }
}

function readEditorPrefs(): EditorPrefs {
  const raw = globalThis.localStorage?.getItem(EDITOR_PREFS_KEY) ?? null
  if (cachedPrefsEntry && cachedPrefsEntry.raw === raw) {
    return cachedPrefsEntry.prefs
  }
  const prefs = parseJsonWithFallback(raw, EditorPrefsSchema, DEFAULT_EDITOR_PREFS)
  cachedPrefsEntry = { raw, prefs }
  return prefs
}

function writeEditorPrefs(next: EditorPrefs): void {
  const serialized = JSON.stringify(next)
  // Update the cache synchronously so subscribers reading the latest value
  // out of `notifyEditorPrefsChanged` see the new prefs even before the
  // localStorage write completes.
  cachedPrefsEntry = { raw: serialized, prefs: next }
  try {
    globalThis.localStorage?.setItem(EDITOR_PREFS_KEY, serialized)
    notifyEditorPrefsChanged()
  } catch {
    // localStorage may be unavailable (private mode, quota, etc.). Editor
    // preferences are best-effort UI state; failing the write is benign.
  }
}

// ---------------------------------------------------------------------------
// Generic getters / setters keyed by catalog id
//
// Two flavours: boolean and string (for select / select-dynamic). Each is
// strongly typed against the catalog so calling
//   readEditorPreference('autoSaveDelay')   // string preference id
// against the boolean variant is a compile error.
// ---------------------------------------------------------------------------

/** Read a single boolean preference, falling back to the catalog default. */
export function readEditorPreferenceBool(id: BooleanPreferenceId): boolean {
  return readEditorPreference(id)
}

function readEditorPreference(id: BooleanPreferenceId): boolean {
  const prefs = readEditorPrefs() as Record<string, unknown>
  const value = prefs[id]
  return typeof value === 'boolean' ? value : defaultBooleanFor(id)
}

/** Persist a single boolean preference and broadcast a change event. */
export function setEditorPreference(id: BooleanPreferenceId, value: boolean): void {
  const current = readEditorPrefs()
  writeEditorPrefs({ ...current, [id]: value })
}

/** Read a select / select-dynamic preference, falling back to the catalog default. */
export function readEditorSelectPreference(id: SelectPreferenceId): string {
  const prefs = readEditorPrefs() as Record<string, unknown>
  const value = prefs[id]
  return typeof value === 'string' && value.length > 0 ? value : defaultSelectFor(id)
}

/** Persist a select / select-dynamic preference and broadcast a change event. */
export function setEditorSelectPreference(id: SelectPreferenceId, value: string): void {
  const current = readEditorPrefs()
  writeEditorPrefs({ ...current, [id]: value })
}

// ---------------------------------------------------------------------------
// Named convenience getters
//
// These wrap `readEditorPreference` for callers that aren't React components
// (auto-save scheduler, etc.) while keeping call sites self-documenting.
// ---------------------------------------------------------------------------

export function readAutoSavePreference(): boolean {
  return readEditorPreference('autoSave')
}

/**
 * Read the auto-save delay preference as milliseconds. The catalog stores the
 * delay in seconds (string) for UI presentation; this function does the
 * conversion to ms so callers don't repeat the parse logic.
 */
export function readAutoSaveDelayMs(): number {
  const seconds = Number(readEditorSelectPreference('autoSaveDelay'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000
}

// ---------------------------------------------------------------------------
// Appearance preferences
//
// These three prefs define admin chrome presentation rather than a single
// component's behaviour. Apply them to the document root so portals mounted
// under document.body (menus, tooltips, modals, toasts) inherit the same token
// scope as the normal React tree.
// ---------------------------------------------------------------------------

export function applyEditorAppearancePreferencesToDocument(
  doc: Document,
  prefs: EditorAppearancePreferences,
): void {
  doc.documentElement.setAttribute('data-editor-density', prefs.density)
  doc.documentElement.setAttribute('data-editor-theme', prefs.theme)
  doc.documentElement.setAttribute('data-editor-text-scale', prefs.textScale)
}

export function useEditorAppearancePreferences(): EditorAppearancePreferences {
  const density = useEditorSelectPreference('density')
  const theme = useEditorSelectPreference('theme')
  const textScale = useEditorSelectPreference('textScale')

  useEffect(() => {
    const doc = globalThis.document
    if (!doc) return
    applyEditorAppearancePreferencesToDocument(doc, { density, theme, textScale })
  }, [density, theme, textScale])

  return { density, theme, textScale }
}

// ---------------------------------------------------------------------------
// Event bus
//
// Same-tab and cross-tab notifications fan out through a single in-process
// subscriber list (`prefsChangeSubscribers`). The cross-tab `storage`
// listener installed by `ensureStorageListenerWired` invalidates the cache
// before notifying subscribers, so listeners that call back into
// `readEditorPrefs` during the callback always see the fresh value.
// ---------------------------------------------------------------------------

function notifyEditorPrefsChanged(): void {
  notifySubscribers()
}

export function subscribeToEditorPrefsChanged(listener: () => void): () => void {
  ensureStorageListenerWired()
  prefsChangeSubscribers.add(listener)
  return () => {
    prefsChangeSubscribers.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// React hook
//
// Components subscribe to a single preference and re-render whenever it
// changes (including from another browser tab). The hook is intentionally
// scoped to one preference per call so React's dependency tracking stays
// trivial — multiple prefs in one component is just multiple hook calls.
// ---------------------------------------------------------------------------

export function useEditorPreference(id: BooleanPreferenceId): boolean {
  // useState initializer reads the freshest value from localStorage. The
  // subscription below keeps the component in sync with subsequent changes
  // (same tab via the custom event, other tabs via the `storage` event).
  const [value, setValue] = useState<boolean>(() => readEditorPreference(id))

  useEffect(() => {
    return subscribeToEditorPrefsChanged(() => {
      setValue(readEditorPreference(id))
    })
  }, [id])

  return value
}

/** React hook for a select / select-dynamic preference. */
export function useEditorSelectPreference(id: SelectPreferenceId): string {
  const [value, setValue] = useState<string>(() => readEditorSelectPreference(id))

  useEffect(() => {
    return subscribeToEditorPrefsChanged(() => {
      setValue(readEditorSelectPreference(id))
    })
  }, [id])

  return value
}
