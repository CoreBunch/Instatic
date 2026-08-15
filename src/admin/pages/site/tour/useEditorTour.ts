/**
 * useEditorTour — auto-start + outcome persistence for the Site editor's
 * first-run guided tour.
 *
 * `startEditorTour()` is the imperative entry point: it hands `editorTourSteps`
 * to the generic `tourStore` along with `persistOutcome` as the `onEnd`
 * callback, so completing or dismissing the tour always saves the
 * `editor-tour` user preference. Callers: `useEditorTour`'s auto-start
 * effect below, and the `site.startTour` pending-action consumer in
 * `SitePage.tsx` (replay from the command palette).
 *
 * `useEditorTour()` mounts once in the Site editor body and auto-starts the
 * tour the first time a user opens the editor — i.e. only when the
 * `editor-tour` preference has never been set (`null`). A preference fetch
 * failure is treated as "already seen": we warn and skip rather than risk
 * re-showing the tour (or blocking the editor) on every load of a broken
 * install.
 */
import { useEffect } from 'react'
import { getUserPreference, setUserPreference } from '@core/persistence/userPreferences'
import { useTourStore, type TourOutcome } from '@admin/shared/tour'
import { editorTourSteps } from './editorTourSteps'

function persistOutcome(outcome: TourOutcome) {
  setUserPreference('editor-tour', { status: outcome }).catch((err) => {
    console.error('[editor-tour] failed to save tour state:', err)
  })
}

/** Starts the editor tour from the top — used for both auto-start and replay. */
export function startEditorTour() {
  useTourStore.getState().start(editorTourSteps, persistOutcome)
}

/**
 * Auto-starts the editor tour on first visit. Mount once in the Site
 * editor body (never outside the site workspace — the tour's anchors and
 * `prepare()` steps are Site-editor-only).
 */
export function useEditorTour() {
  useEffect(() => {
    let cancelled = false

    getUserPreference('editor-tour')
      .then((pref) => {
        if (cancelled) return
        // Never seen AND no tour already running (e.g. a queued
        // `site.startTour` replay that raced this fetch).
        if (pref === null && useTourStore.getState().steps === null) {
          startEditorTour()
        }
      })
      .catch((err) => {
        // Treat as already-seen: never block or spam an erroring install.
        console.warn('[editor-tour] preference read failed, skipping auto-start:', err)
      })

    return () => {
      cancelled = true
    }
  }, [])
}
