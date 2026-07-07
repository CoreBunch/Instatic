/**
 * usePersistence — React hook that wires the Zustand store to the CMS persistence adapter.
 *
 * Responsibilities:
 *  1. LOAD on mount  — loads the single CMS draft site document; falls back to
 *     creating a fresh blank draft when the CMS has no draft yet.
 *  2. AUTO-SAVE      — when enabled in preferences, debounced 30 s after the
 *     `hasUnsavedChanges` flag transitions to true. Timer is properly reset on
 *     each new change so that rapid edits collapse into a single save.
 *  3. MANUAL SAVE    — returned as a stable callback for toolbar Save and used
 *     by Cmd+S / Ctrl+S. Resets the unsaved-changes flag.
 *
 * Constraint #230: raw adapter data is validated via `validateSite` before
 * being passed to `store.loadSite()`.
 *
 * Mount it once at the top of EditorLayout and pass the returned save callback
 * to toolbar chrome that needs an explicit Save action.
 *
 * Guideline #239 / selector-stability note:
 *   All store reads inside effects use `useEditorStore.getState()` (point-in-time
 *   snapshots) rather than `useEditorStore(selector)` React hooks. This avoids
 *   subscribing EditorLayout to store changes from within this hook, which would
 *   cause spurious re-renders.
 *
 *   The auto-save subscription uses a primitive boolean selector
 *   `(s) => s.hasUnsavedChanges` so that `Object.is` comparisons work correctly
 *   and the listener fires ONLY when the flag actually changes — not on every
 *   single store update.  Using an inline object selector like
 *   `(s) => ({ site: s.site, dirty: s.hasUnsavedChanges })` would create
 *   a brand-new object on every evaluation, causing the listener to fire on
 *   every store mutation and leaking unbounded setTimeout instances.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { SiteDocument } from '@core/page-tree'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { cmsAdapter } from '@core/persistence/cms'
import { SiteValidationError } from '@core/persistence/validate'
import {
  readAutoSaveDelayMs,
  readAutoSavePreference,
  readEditorSelectPreference,
  subscribeToEditorPrefsChanged,
} from '@site/preferences/editorPreferences'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { registerEditorSave } from './editorSaveRef'

/**
 * Re-exported for back-compat. The canonical declaration lives in
 * `@admin/state/adminEvents` so plugin code (which just dispatches the
 * event after a pack install) can import the constant without dragging
 * this whole hook — and its editor-store dependency — into the
 * non-editor admin bundle.
 */

import {
  CMS_SITE_RELOAD_EVENT,
  EDITOR_SAVE_REQUEST_EVENT,
  consumePendingCmsSiteReload,
  hasPendingCmsSiteReload,
} from '@admin/state/adminEvents'

export interface PersistenceSaveStatus {
  state: 'loading' | 'saved' | 'unsaved' | 'saving' | 'error'
  message?: string
  lastSavedAt?: number
}

interface PersistenceController {
  saveSite: () => Promise<void>
  saveStatus: PersistenceSaveStatus
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback
}

function currentEditorDataDeepLink(): { table: 'pages' | 'components'; rowId: string } | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const table = params.get('table')
  const rowId = params.get('row')
  if (!rowId) return null
  if (table !== 'pages' && table !== 'components') return null
  return { table, rowId }
}

function siteMissesEditorDataDeepLink(site: SiteDocument): boolean {
  const deepLink = currentEditorDataDeepLink()
  if (!deepLink) return false
  if (deepLink.table === 'pages') {
    return !site.pages.some((page) => page.id === deepLink.rowId)
  }
  return !site.visualComponents.some((component) => component.id === deepLink.rowId)
}

/**
 * Apply the user's `defaultBreakpoint` preference if the loaded site declares
 * a matching breakpoint id. Falls back silently when the preference points to
 * a breakpoint the current site doesn't have (e.g. user previously edited a
 * site with a custom 'wide' breakpoint, then opened a site without it).
 */
function applyDefaultBreakpointPreference(
  breakpoints: ReadonlyArray<{ id: string }>,
): void {
  const preferredId = readEditorSelectPreference('defaultBreakpoint')
  if (!breakpoints.some((bp) => bp.id === preferredId)) return
  useEditorStore.getState().setActiveBreakpoint(preferredId)
}

export function usePersistence(
  requestedSiteId = 'default',
  adapter: IPersistenceAdapter = cmsAdapter,
  options: { markNewSiteUnsaved?: boolean; enabled?: boolean } = {},
): PersistenceController {
  const markNewSiteUnsaved = options.markNewSiteUnsaved ?? false
  const enabled = options.enabled ?? true
  const [saveStatus, setSaveStatus] = useState<PersistenceSaveStatus>(
    enabled ? { state: 'loading' } : { state: 'saved' },
  )
  /** Whether the initial load has completed — prevents auto-save before load */
  const loadedRef = useRef(false)
  /** Stable reference to the adapter so it doesn't trigger re-renders */
  const adapterRef = useRef(adapter)
  useEffect(() => {
    adapterRef.current = adapter
  }, [adapter])

  /** The save currently on the wire, if any. */
  const inFlightSaveRef = useRef<Promise<void> | null>(null)
  /** The single queued follow-up save every mid-flight trigger coalesces into. */
  const queuedSaveRef = useRef<Promise<void> | null>(null)

  // Exception #1: referenced in the useCallback dep array of saveCurrentSite,
  // so exhaustive-deps requires a stable identity here.
  const runSave = useCallback(async () => {
    const { site, setHasUnsavedChanges, takeDirtySaveSnapshot, restoreDirtySaveSnapshot } =
      useEditorStore.getState()
    if (!site) return

    setSaveStatus({ state: 'saving', message: 'Saving draft' })
    // Snapshot-and-reset the dirty marks BEFORE the await: edits landing while
    // the save is in flight accumulate fresh marks for the NEXT save, and a
    // failed save merges this snapshot back so nothing is lost.
    const dirty = takeDirtySaveSnapshot()
    try {
      await adapterRef.current.saveSite(site, { dirty })
      // Clear the unsaved flag ONLY when no mutation landed while the save
      // was on the wire — every store mutation produces a new `site`
      // reference, so reference equality is the exact signal. Without this
      // guard a mid-flight edit would lose its "unsaved" status (and the
      // queued follow-up save would be skipped, dropping the edit until the
      // next mutation re-set the flag).
      if (useEditorStore.getState().site === site) setHasUnsavedChanges(false)
      setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
    } catch (err) {
      restoreDirtySaveSnapshot(dirty)
      setSaveStatus({ state: 'error', message: errorMessage(err, 'Save failed') })
      throw err
    }
  }, [])

  /**
   * SINGLE-FLIGHT save queue: at most one save on the wire and at most one
   * queued follow-up. Every trigger (autosave, Cmd+S, save-request events,
   * the MCP bridge, unmount flush) funnels through here, so two saves can
   * never interleave — the failure mode the four-request protocol used to
   * have. A queued save reads the LATEST store state when it runs, so N
   * triggers during one in-flight save collapse into a single follow-up; it
   * is skipped entirely when the in-flight save already shipped everything
   * (no unsaved changes remain).
   *
   * Exception #1: referenced in useEffect dep arrays below, so
   * exhaustive-deps requires a stable identity here.
   */
  const saveCurrentSite = useCallback((): Promise<void> => {
    const start = (): Promise<void> => {
      const run = runSave().finally(() => {
        if (inFlightSaveRef.current === run) inFlightSaveRef.current = null
      })
      inFlightSaveRef.current = run
      return run
    }

    const inFlight = inFlightSaveRef.current
    if (!inFlight) return start()

    queuedSaveRef.current ??= inFlight
      // A failed in-flight save must not cancel the queued retry — its dirty
      // marks were restored, so the follow-up ships them again.
      .catch(() => {})
      .then(() => {
        queuedSaveRef.current = null
        // The in-flight save may have already shipped everything (trigger
        // spam without new edits) — skip the pointless follow-up.
        if (!useEditorStore.getState().hasUnsavedChanges) return
        return start()
      })
    return queuedSaveRef.current
  }, [runSave])

  // Expose the save to the MCP editor-bridge so a write tool relayed from an
  // external agent can flush to the DB before a follow-up headless read.
  useEffect(() => registerEditorSave(saveCurrentSite), [saveCurrentSite])

  // ─── 1. Load site document on mount ────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      loadedRef.current = true
      return
    }

    let cancelled = false

    async function load() {
      // Read actions point-in-time — no React subscription needed
      const {
        site: existingSite,
        hasUnsavedChanges,
        loadSite,
        createSite,
        setHasUnsavedChanges,
      } = useEditorStore.getState()

      const pendingCmsSiteReload = hasPendingCmsSiteReload()
      const shouldReloadExistingSite = existingSite
        ? pendingCmsSiteReload || siteMissesEditorDataDeepLink(existingSite)
        : false

      if (existingSite && !shouldReloadExistingSite) {
        loadedRef.current = true
        setSaveStatus(
          hasUnsavedChanges
            ? { state: 'unsaved', message: 'Unsaved changes' }
            : { state: 'saved', lastSavedAt: Date.now() },
        )
        return
      }

      const idToTry = requestedSiteId || 'default'

      if (idToTry) {
        try {
          // The adapter validates internally (validateSite + validatePages).
          // Constraint #230 is satisfied at the adapter boundary.
          const site = await adapterRef.current.loadSite(idToTry)
          if (site && !cancelled) {
            if (pendingCmsSiteReload) consumePendingCmsSiteReload()
            loadSite(site)
            applyDefaultBreakpointPreference(site.breakpoints)
            loadedRef.current = true
            setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
            return
          }
        } catch (err) {
          if (err instanceof SiteValidationError) {
            console.warn('[persistence] Corrupt CMS site data:', err.message)
          } else {
            console.warn('[persistence] Failed to load CMS site:', err)
          }
          if (!cancelled) {
            setSaveStatus({ state: 'error', message: errorMessage(err, 'Failed to load CMS site') })
          }
          return
        }
      }

      if (cancelled) return
      if (pendingCmsSiteReload) consumePendingCmsSiteReload()

      if (existingSite) {
        loadedRef.current = true
        setSaveStatus(
          hasUnsavedChanges
            ? { state: 'unsaved', message: 'Unsaved changes' }
            : { state: 'saved', lastSavedAt: Date.now() },
        )
        return
      }

      // Bootstrap a fresh draft once for new installs that have an admin/site row
      // but no instatic document yet.
      if (!cancelled) {
        const created = createSite('My Site')
        applyDefaultBreakpointPreference(created.breakpoints)
        loadedRef.current = true
        try {
          // Replace-mode full save (no dirty hints): the site doesn't exist
          // in storage yet.
          await adapterRef.current.saveSite(created)
          // Storage now matches the store — drop the createSite all-dirty mark.
          useEditorStore.getState().takeDirtySaveSnapshot()
          setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
        } catch (err) {
          setHasUnsavedChanges(true)
          setSaveStatus({
            state: markNewSiteUnsaved ? 'unsaved' : 'error',
            message: errorMessage(err, 'Draft not saved yet'),
          })
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [enabled, markNewSiteUnsaved, requestedSiteId])

  // External "site changed at the server" hook. Non-editor workspaces call
  // `requestCmsSiteReload()`, which retains the reload if this hook is not
  // mounted yet and dispatches `CMS_SITE_RELOAD_EVENT` for live editor mounts.
  useEffect(() => {
    if (!enabled) return undefined

    async function reload() {
      const idToTry = requestedSiteId || 'default'
      const pendingCmsSiteReload = hasPendingCmsSiteReload()
      try {
        // Adapter validates internally (Constraint #230).
        const site = await adapterRef.current.loadSite(idToTry)
        if (!site) {
          if (pendingCmsSiteReload) consumePendingCmsSiteReload()
          return
        }
        const { loadSite, setHasUnsavedChanges } = useEditorStore.getState()
        loadSite(site)
        applyDefaultBreakpointPreference(site.breakpoints)
        // The site doc on disk is now authoritative; clear the unsaved flag so
        // the auto-save loop doesn't immediately overwrite it back.
        setHasUnsavedChanges(false)
        if (pendingCmsSiteReload) consumePendingCmsSiteReload()
        setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
      } catch (err) {
        console.error('[persistence] Reload after pack install failed:', err)
      }
    }

    function handleReload() {
      void reload()
    }

    window.addEventListener(CMS_SITE_RELOAD_EVENT, handleReload)
    return () => window.removeEventListener(CMS_SITE_RELOAD_EVENT, handleReload)
  }, [enabled, requestedSiteId])

  // ─── 2. Auto-save (debounced) ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return undefined

    // Primitive boolean selector — Object.is works correctly, listener fires
    // ONLY when hasUnsavedChanges actually changes (false→true or true→false).
    // This avoids creating a new object on every selector evaluation (which
    // would cause the listener to run on every store mutation — timer leak).
    let timer: ReturnType<typeof setTimeout> | undefined

    function scheduleAutoSave() {
      clearTimeout(timer)
      if (!loadedRef.current) return
      if (!useEditorStore.getState().hasUnsavedChanges) return
      if (!readAutoSavePreference()) return

      // Read the delay each time auto-save is scheduled — toggling the
      // preference re-fires `subscribeToEditorPrefsChanged` which calls back
      // into this scheduler, so the next scheduled tick uses the fresh value.
      timer = setTimeout(() => {
        void saveCurrentSite().catch((err) => {
          console.error('[persistence] Auto-save failed:', err)
        })
      }, readAutoSaveDelayMs())
    }

    const unsub = useEditorStore.subscribe(
      (s) => s.hasUnsavedChanges,
      (dirty) => {
        if (!dirty) {
          clearTimeout(timer)
          setSaveStatus((status) =>
            status.state === 'saving' ? status : { state: 'saved', lastSavedAt: status.lastSavedAt }
          )
          return
        }
        setSaveStatus({ state: 'unsaved', message: 'Unsaved changes' })
        scheduleAutoSave()
      },
    )
    const prefsUnsub = subscribeToEditorPrefsChanged(scheduleAutoSave)

    // beforeunload flush — tab close / hard reload. Fire-and-forget: the
    // handler cannot await async work, so this bypasses the save queue and
    // ships the current netted marks WITHOUT resetting them (a failed flush
    // is retried by the next save). One request now, so either the whole
    // save lands or none of it does — no partial-prefix commits at unload.
    function flushBeforeUnload() {
      const { site, hasUnsavedChanges, peekDirtySaveSnapshot } = useEditorStore.getState()
      if (!site || !loadedRef.current || !hasUnsavedChanges) return
      clearTimeout(timer)
      void adapterRef.current
        .saveSite(site, { dirty: peekDirtySaveSnapshot() })
        .catch((err) => {
          console.error('[persistence] flush save failed:', err)
        })
    }

    window.addEventListener('beforeunload', flushBeforeUnload)

    return () => {
      unsub()
      prefsUnsub()
      clearTimeout(timer)
      window.removeEventListener('beforeunload', flushBeforeUnload)
      // Unmount cleanup — in-app SPA navigation AWAY from the editor (e.g. to
      // the Data view), which does NOT fire `beforeunload`. Unlike unload,
      // the promise survives unmount, so this routes through the save queue
      // and can never interleave with an in-flight autosave.
      const { site, hasUnsavedChanges } = useEditorStore.getState()
      if (site && loadedRef.current && hasUnsavedChanges) {
        void saveCurrentSite().catch((err) => {
          console.error('[persistence] flush save failed:', err)
        })
      }
    }
  }, [enabled, saveCurrentSite])

  // ─── Immediate-save requests ───────────────────────────────────────────────
  // Deliberate, discrete save actions (e.g. "Save as layout") dispatch
  // EDITOR_SAVE_REQUEST_EVENT to commit right away instead of waiting for the
  // autosave debounce. Runs the same pipeline as Cmd+S (snapshot dirty marks,
  // reset the unsaved flag), independent of the autosave preference.
  useEffect(() => {
    if (!enabled) return undefined

    function handleSaveRequest() {
      void saveCurrentSite().catch((err) => {
        console.error('[persistence] Save request failed:', err)
      })
    }

    window.addEventListener(EDITOR_SAVE_REQUEST_EVENT, handleSaveRequest)
    return () => window.removeEventListener(EDITOR_SAVE_REQUEST_EVENT, handleSaveRequest)
  }, [enabled, saveCurrentSite])

  // ─── 3. Cmd/Ctrl+S — immediate save ───────────────────────────────────────
  // Match predicate comes from the keybindings registry — single source of truth.
  useEffect(() => {
    if (!enabled) return undefined

    const kbSave = getKeybindingForCommand('editor.save')

    async function handleKeyDown(e: KeyboardEvent) {
      if (!kbSave?.match(e)) return
      e.preventDefault()

      try {
        await saveCurrentSite()
      } catch (err) {
        console.error('[persistence] Manual save failed:', err)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, saveCurrentSite])

  return { saveSite: saveCurrentSite, saveStatus }
}
