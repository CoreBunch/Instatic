/**
 * usePersistence — React hook that wires the Zustand store to an IPersistenceAdapter.
 *
 * Responsibilities:
 *  1. LOAD on mount  — loads the project identified by the URL param from the
 *     adapter; falls back to the most-recently-opened project; falls back to
 *     creating a fresh blank project.
 *  2. AUTO-SAVE      — debounced 30 s after the `hasUnsavedChanges` flag
 *     transitions to true. Timer is properly reset on each new change so that
 *     rapid edits collapse into a single save.
 *  3. CMD+S / CTRL+S — immediate save, resets the unsaved-changes flag.
 *
 * Constraint #230: raw adapter data is validated via `validateProject` before
 * being passed to `store.loadProject()`.
 *
 * Design: the hook is intentionally side-effect-only — it returns nothing.
 * Mount it once at the top of EditorLayout.
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
 *   `(s) => ({ project: s.project, dirty: s.hasUnsavedChanges })` would create
 *   a brand-new object on every evaluation, causing the listener to fire on
 *   every store mutation and leaking unbounded setTimeout instances.
 */
import { useEffect, useRef } from 'react'
import { useEditorStore } from '@core/editor-store/store'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { localAdapter } from '@core/persistence/local'
import { validateProject, ValidationError } from '@core/persistence/validate'

/** localStorage key tracking the most-recently-opened project ID */
const LAST_PROJECT_KEY = 'pb-last-project-id'
/** Auto-save debounce interval in milliseconds */
const AUTO_SAVE_DELAY_MS = 30_000

export function usePersistence(
  requestedProjectId: string | undefined,
  adapter: IPersistenceAdapter = localAdapter,
) {
  /** Whether the initial load has completed — prevents auto-save before load */
  const loadedRef = useRef(false)
  /** Stable reference to the adapter so it doesn't trigger re-renders */
  const adapterRef = useRef(adapter)
  useEffect(() => {
    adapterRef.current = adapter
  }, [adapter])

  // ─── 1. Load project on mount ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      // Read actions point-in-time — no React subscription needed
      const { loadProject, createProject } = useEditorStore.getState()

      const idToTry = requestedProjectId && requestedProjectId !== 'new-project'
        ? requestedProjectId
        : localStorage.getItem(LAST_PROJECT_KEY) ?? undefined

      if (idToTry) {
        try {
          const raw = await adapterRef.current.loadProject(idToTry)
          if (raw && !cancelled) {
            // Constraint #230 — validate before hydrating the store
            const validated = validateProject(raw)
            loadProject(validated)
            localStorage.setItem(LAST_PROJECT_KEY, validated.id)
            loadedRef.current = true
            return
          }
        } catch (err) {
          if (err instanceof ValidationError) {
            console.warn('[persistence] Corrupt project data, creating blank project:', err.message)
          } else {
            console.warn('[persistence] Failed to load project, creating blank project:', err)
          }
        }
      }

      // Fallback: create a fresh blank project
      if (!cancelled) {
        const newProjectId = requestedProjectId && requestedProjectId !== 'new-project'
          ? requestedProjectId
          : undefined
        const newProject = createProject('My Project', newProjectId)
        localStorage.setItem(LAST_PROJECT_KEY, newProject.id)
        loadedRef.current = true
      }
    }

    load()
    return () => { cancelled = true }
  }, [requestedProjectId])

  // ─── 2. Auto-save (debounced) ──────────────────────────────────────────────
  useEffect(() => {
    // Primitive boolean selector — Object.is works correctly, listener fires
    // ONLY when hasUnsavedChanges actually changes (false→true or true→false).
    // This avoids creating a new object on every selector evaluation (which
    // would cause the listener to run on every store mutation — timer leak).
    let timer: ReturnType<typeof setTimeout> | undefined

    const unsub = useEditorStore.subscribe(
      (s) => s.hasUnsavedChanges,
      (dirty) => {
        if (!loadedRef.current || !dirty) return

        // Reset the debounce timer on every new dirty transition so rapid edits
        // collapse into a single save.
        clearTimeout(timer)
        timer = setTimeout(async () => {
          // Read the latest project snapshot at save time, not at subscription time.
          const project = useEditorStore.getState().project
          if (!project) return
          try {
            await adapterRef.current.saveProject(project)
            localStorage.setItem(LAST_PROJECT_KEY, project.id)
            useEditorStore.getState().setHasUnsavedChanges(false)
          } catch (err) {
            console.error('[persistence] Auto-save failed:', err)
          }
        }, AUTO_SAVE_DELAY_MS)
      },
    )

    // beforeunload flush — prevent data loss on tab close (Phase 5 Gate 3).
    // The 30s debounce means the last unsaved edit would be dropped without this.
    // Fire-and-forget: beforeunload can't await async work. Synchronous adapter
    // writes (e.g. localStorage) complete reliably; IndexedDB may not.
    function flushOnUnload() {
      const project = useEditorStore.getState().project
      if (!project || !loadedRef.current) return
      clearTimeout(timer)
      void adapterRef.current.saveProject(project)
    }

    window.addEventListener('beforeunload', flushOnUnload)

    return () => {
      unsub()
      clearTimeout(timer)
      window.removeEventListener('beforeunload', flushOnUnload)
    }
  }, [])

  // ─── 3. Cmd/Ctrl+S — immediate save ───────────────────────────────────────
  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return
      e.preventDefault()

      // Point-in-time snapshot — no React subscription needed
      const { project, setHasUnsavedChanges } = useEditorStore.getState()
      if (!project) return

      try {
        await adapterRef.current.saveProject(project)
        localStorage.setItem(LAST_PROJECT_KEY, project.id)
        setHasUnsavedChanges(false)
      } catch (err) {
        console.error('[persistence] Manual save failed:', err)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
