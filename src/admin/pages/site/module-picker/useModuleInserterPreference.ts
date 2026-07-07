import { useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_MODULE_INSERTER_PREFERENCE,
  getUserPreference,
  setUserPreference,
  type ModuleInserterItemRef,
} from '@core/persistence/userPreferences'
import { ApiError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  dedupeModuleInserterRefs,
  recentKey,
} from './moduleInserterModel'

interface ModuleInserterPreferenceApi {
  favorites: ModuleInserterItemRef[]
  loading: boolean
  error: string | null
  isFavorite: (ref: ModuleInserterItemRef | null) => boolean
  toggleFavorite: (ref: ModuleInserterItemRef | null) => void
  setFavorites: (refs: readonly ModuleInserterItemRef[]) => void
}

interface ModuleInserterPreferenceSnapshot {
  favorites: ModuleInserterItemRef[]
  loading: boolean
  error: string | null
}

const DEFAULT_FAVORITES = DEFAULT_MODULE_INSERTER_PREFERENCE.favorites

const listeners = new Set<() => void>()
let snapshot: ModuleInserterPreferenceSnapshot = initialSnapshot()
let loadPromise: Promise<void> | null = null
let mutationVersion = 0

export function useModuleInserterPreference(): ModuleInserterPreferenceApi {
  const current = useSyncExternalStore(
    subscribeModuleInserterPreference,
    getModuleInserterPreferenceSnapshot,
    getModuleInserterPreferenceSnapshot,
  )

  useEffect(() => {
    ensureModuleInserterPreferenceLoaded()
  }, [])

  function saveFavorites(nextFavorites: readonly ModuleInserterItemRef[]) {
    const next = dedupeModuleInserterRefs(nextFavorites)
    const saveVersion = ++mutationVersion
    setSnapshot({ favorites: next, loading: false, error: null })

    void setUserPreference('module-inserter', { favorites: next })
      .then((saved) => {
        if (saveVersion !== mutationVersion) return
        setSnapshot({
          favorites: dedupeModuleInserterRefs(saved.favorites),
          loading: false,
          error: null,
        })
      })
      .catch((err) => {
        if (saveVersion !== mutationVersion) return
        const message = getErrorMessage(err, 'Failed to save module inserter preferences')
        console.error('[module-inserter] failed to save user preference:', err)
        setSnapshot({ ...snapshot, loading: false, error: message })
      })
  }

  function isFavorite(ref: ModuleInserterItemRef | null): boolean {
    if (!ref) return false
    const key = recentKey(ref)
    return current.favorites.some((favorite) => recentKey(favorite) === key)
  }

  function toggleFavorite(ref: ModuleInserterItemRef | null): void {
    if (!ref) return
    const key = recentKey(ref)
    const existing = current.favorites.some((favorite) => recentKey(favorite) === key)
    saveFavorites(
      existing
        ? current.favorites.filter((favorite) => recentKey(favorite) !== key)
        : [...current.favorites, ref],
    )
  }

  return {
    favorites: current.favorites,
    loading: current.loading,
    error: current.error,
    isFavorite,
    toggleFavorite,
    setFavorites: saveFavorites,
  }
}

function initialSnapshot(): ModuleInserterPreferenceSnapshot {
  return {
    favorites: [...DEFAULT_FAVORITES],
    loading: true,
    error: null,
  }
}

function subscribeModuleInserterPreference(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getModuleInserterPreferenceSnapshot(): ModuleInserterPreferenceSnapshot {
  return snapshot
}

function setSnapshot(next: ModuleInserterPreferenceSnapshot) {
  snapshot = next
  for (const listener of listeners) listener()
}

function ensureModuleInserterPreferenceLoaded() {
  if (loadPromise) return

  const loadMutationVersion = mutationVersion
  loadPromise = (async () => {
    try {
      const stored = await getUserPreference('module-inserter')
      if (mutationVersion !== loadMutationVersion) {
        setSnapshot({ ...snapshot, loading: false })
        return
      }
      setSnapshot({
        favorites: stored ? dedupeModuleInserterRefs(stored.favorites) : [...DEFAULT_FAVORITES],
        loading: false,
        error: null,
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSnapshot({
          favorites: [...DEFAULT_FAVORITES],
          loading: false,
          error: null,
        })
        return
      }
      const message = getErrorMessage(err, 'Failed to load module inserter preferences')
      console.error('[module-inserter] failed to load user preference:', err)
      setSnapshot({
        ...snapshot,
        loading: false,
        error: mutationVersion === loadMutationVersion ? message : snapshot.error,
      })
    }
  })()
}

export function __resetModuleInserterPreferenceForTests() {
  listeners.clear()
  snapshot = initialSnapshot()
  loadPromise = null
  mutationVersion = 0
}
