/**
 * usePersistence — React hook that boots the editor's document lifecycle.
 *
 * Responsibilities:
 *  1. LOAD on mount — fetch the CMS draft site over HTTP and hydrate the
 *     store (fast first paint), falling back to bootstrapping a fresh blank
 *     draft for new installs.
 *  2. CONNECT — open the collab provider (one WebSocket, every doc
 *     multiplexed) and hand it to the store's collab binding. From that
 *     moment every local mutation streams to the relay (which persists
 *     continuously) and every remote peer's edit projects into the store.
 *     There is no client-side save pipeline anymore — no autosave timer, no
 *     Cmd+S, no dirty tracking, no beforeunload flush.
 *  3. STATUS — map load state + provider connection state onto the toolbar
 *     status chip (`loading` / `synced` / `connecting` / `offline` / `error`).
 *
 * Constraint #230: raw adapter data is validated via `validateSite` before
 * being passed to `store.loadSite()`.
 *
 * Guideline #239 / selector-stability note: store reads inside effects use
 * `useEditorStore.getState()` (point-in-time snapshots) rather than
 * `useEditorStore(selector)` hooks, so this hook never subscribes its host
 * component to store changes.
 */
import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { SiteDocument } from '@core/page-tree'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { cmsAdapter } from '@core/persistence/cms'
import { SiteValidationError } from '@core/persistence/validate'
import { getErrorMessage } from '@core/utils/errorMessage'
import { readEditorSelectPreference } from '@site/preferences/editorPreferences'
import type { CollabProvider } from '@site/collab/collabProvider'
import {
  connectCollabProvider,
  disconnectCollabProvider,
} from '@site/store/slices/site/collabBinding'
import {
  consumePendingCmsSiteReload,
  hasPendingCmsSiteReload,
} from '@admin/state/adminEvents'

export interface PersistenceSaveStatus {
  state: 'loading' | 'synced' | 'connecting' | 'offline' | 'error'
  message?: string
}

interface PersistenceController {
  saveStatus: PersistenceSaveStatus
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
  options: { enabled?: boolean } = {},
): PersistenceController {
  const enabled = options.enabled ?? true
  const [loadState, setLoadState] = useState<{ phase: 'loading' | 'ready' | 'error'; message?: string }>(
    enabled ? { phase: 'loading' } : { phase: 'ready' },
  )
  const [collabState, setCollabState] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  /** Stable reference to the adapter so a per-render instance can't re-trigger the load effect. */
  const adapterRef = useRef(adapter)
  useEffect(() => {
    adapterRef.current = adapter
  }, [adapter])

  // ─── 1. Load site document + connect the collab provider ──────────────────
  useEffect(() => {
    if (!enabled) return undefined

    let cancelled = false
    let connected = false

    async function load(): Promise<void> {
      // Read actions point-in-time — no React subscription needed.
      const { site: existingSite, loadSite, createSite } = useEditorStore.getState()

      const pendingCmsSiteReload = hasPendingCmsSiteReload()
      const shouldReloadExistingSite = existingSite
        ? pendingCmsSiteReload || siteMissesEditorDataDeepLink(existingSite)
        : false

      if (existingSite && !shouldReloadExistingSite) {
        // In-memory document from an earlier editor mount. The provider
        // connect below re-syncs every doc against the server, so any drift
        // (writes from other admins / plugins while we were away) projects in.
        setLoadState({ phase: 'ready' })
        return
      }

      const idToTry = requestedSiteId || 'default'

      try {
        // The adapter validates internally (validateSite + validatePages) —
        // Constraint #230 is satisfied at the adapter boundary.
        const result = await adapterRef.current.loadSite(idToTry)
        if (cancelled) return
        if (result) {
          if (pendingCmsSiteReload) consumePendingCmsSiteReload()
          loadSite(result.site)
          applyDefaultBreakpointPreference(result.site.breakpoints)
          setLoadState({ phase: 'ready' })
          return
        }
      } catch (err) {
        if (err instanceof SiteValidationError) {
          console.warn('[persistence] Corrupt CMS site data:', err.message)
        } else {
          console.warn('[persistence] Failed to load CMS site:', err)
        }
        if (!cancelled) {
          setLoadState({ phase: 'error', message: getErrorMessage(err, 'Failed to load CMS site') })
        }
        return
      }

      if (cancelled) return
      if (pendingCmsSiteReload) consumePendingCmsSiteReload()

      // Bootstrap a fresh draft once for new installs that have an admin/site
      // row but no instatic document yet. The one HTTP save creates the
      // storage rows; the provider connect below then binds the server-seeded
      // docs for them.
      const created = createSite('My Site')
      applyDefaultBreakpointPreference(created.breakpoints)
      try {
        await adapterRef.current.saveSite(created)
        if (!cancelled) setLoadState({ phase: 'ready' })
      } catch (err) {
        if (!cancelled) {
          setLoadState({ phase: 'error', message: getErrorMessage(err, 'Draft not saved yet') })
        }
      }
    }

    let provider: CollabProvider | null = null
    let offStatus: (() => void) | null = null

    async function boot(): Promise<void> {
      // Fetch the provider module (yjs transport) in parallel with the HTTP
      // load — a dynamic import keeps it out of the route-shell chunk.
      const providerModule = import('@site/collab/collabProvider')
      await load()
      if (cancelled) return
      // Only connect when the store actually holds a site to bind. A hard load
      // failure with NO in-memory site would otherwise open a socket with zero
      // docs and an infinite reconnect loop; skip it and let saveStatus show
      // the error. When a stale in-memory site survived a transient reload
      // failure, we DO connect — live sync recovers against those docs and the
      // connected state then supersedes the stale load error in saveStatus.
      if (useEditorStore.getState().site === null) return
      const { createCollabProvider } = await providerModule
      if (cancelled) return
      provider = createCollabProvider()
      offStatus = provider.onStatus((status) => {
        setCollabState(status === 'connected' ? 'connected' : status)
      })
      setCollabState(provider.status() === 'connected' ? 'connected' : provider.status())
      // Connect AFTER the HTTP load hydrated the store: connectCollabProvider
      // rebinds every doc for the loaded site through the provider
      // (server-seeded), and the HTTP-loaded projection keeps the canvas
      // painted while the initial sync streams in.
      connected = true
      connectCollabProvider(provider)
    }
    void boot()

    return () => {
      cancelled = true
      offStatus?.()
      if (connected) {
        // Tears the provider down AND resets the binding to detached docs
        // seeded from whatever site the store still holds.
        disconnectCollabProvider()
      } else {
        // Unmounted before the connect happened — the binding never adopted
        // this provider, so destroy it directly.
        provider?.destroy()
      }
    }
  }, [enabled, requestedSiteId])

  const saveStatus: PersistenceSaveStatus =
    loadState.phase === 'loading'
      ? { state: 'loading' }
      : // A live connection supersedes a stale load error: if a transient
        // reload failed but the provider synced the in-memory docs anyway,
        // editing works — don't show a permanent "Sync failed".
        collabState === 'connected'
        ? { state: 'synced' }
        : loadState.phase === 'error'
          ? { state: 'error', message: loadState.message }
          : collabState === 'connecting'
            ? { state: 'connecting' }
            : { state: 'offline', message: 'Reconnecting' }

  return { saveStatus }
}
