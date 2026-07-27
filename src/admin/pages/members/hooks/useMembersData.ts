/**
 * useMembersData — central data store for the Members workspace.
 *
 * Mirrors `pages/users/hooks/useUsersPageData.ts`: loads visitor users +
 * roles in parallel, exposes mutable state setters for optimistic updates,
 * and reconciles authoritative state from the server via `refresh()`.
 *
 * Differences from the Users hook:
 *   - The visitor list is paginated + searchable server-side, so this hook
 *     owns a debounced `search` string (the table's search box feeds
 *     `setSearch`; the list re-queries ~250ms after typing stops).
 *   - Roles don't depend on the search filter, so they're fetched once on
 *     mount instead of on every search change.
 *   - Visitor mutations are NOT step-up gated (unlike admin user
 *     suspension), so there's no step-up plumbing here.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  listVisitorGroups,
  listVisitorRoles,
  listVisitorUsers,
  type AdminVisitorUser,
  type VisitorGroup,
  type VisitorRole,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'

/** Debounce window for the search box before re-querying the list. */
const SEARCH_DEBOUNCE_MS = 250

export interface MembersData {
  users: AdminVisitorUser[]
  roles: VisitorRole[]
  groups: VisitorGroup[]
  total: number
  loading: boolean
  error: string | null
  /** Current (un-debounced) search-box value. */
  search: string
  setSearch: (value: string) => void
  setUsers: (updater: (current: AdminVisitorUser[]) => AdminVisitorUser[]) => void
  setRoles: (updater: (current: VisitorRole[]) => VisitorRole[]) => void
  setGroups: (updater: (current: VisitorGroup[]) => VisitorGroup[]) => void
  setError: (value: string | null) => void
  refresh: () => Promise<void>
}

export function useMembersData(): MembersData {
  const [users, setUsersState] = useState<AdminVisitorUser[]>([])
  const [roles, setRoles] = useState<VisitorRole[]>([])
  const [groups, setGroups] = useState<VisitorGroup[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Debounce the search box so each keystroke doesn't fire a fresh query.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [search])

  // Roles + groups are independent of the search filter — load once on mount.
  // Failures are swallowed: the role picker falls back to the raw roleId and
  // the group surfaces fall back to empty; surfacing a hard error here would
  // block the whole table for a best-effort enrichment.
  useEffect(() => {
    let cancelled = false
    Promise.all([listVisitorRoles(), listVisitorGroups()])
      .then(([loadedRoles, loadedGroups]) => {
        if (!cancelled) {
          setRoles(loadedRoles)
          setGroups(loadedGroups)
        }
      })
      .catch(() => {
        /* best-effort — pickers fall back to raw ids */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Load (or reload) the visitor list. Re-runs whenever the debounced search
  // changes. A superseded/unmounted load discards its result via `cancelled`.
  // setState calls live inside the async callbacks (not the effect body) so
  // `react-hooks/set-state-in-effect` stays clean — same shape as
  // `useUsersPageData`. `loading` is seeded true by useState and flips false
  // after the first load; search-triggered reloads keep the current rows
  // visible instead of flashing the skeleton.
  useEffect(() => {
    let cancelled = false
    listVisitorUsers({ search: debouncedSearch || undefined })
      .then(({ users: loadedUsers, total: loadedTotal }) => {
        if (cancelled) return
        setUsersState(loadedUsers)
        setTotal(loadedTotal)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(getErrorMessage(err, 'Could not load visitors'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedSearch])

  // Exception #1 (react-hooks/exhaustive-deps): the table places `refresh` in
  // mutation handlers; it needs a stable identity the static lint can see.
  const refresh = useCallback(async () => {
    setError(null)
    try {
      const { users: loadedUsers, total: loadedTotal } = await listVisitorUsers({
        search: debouncedSearch || undefined,
      })
      setUsersState(loadedUsers)
      setTotal(loadedTotal)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not load visitors'))
    }
  }, [debouncedSearch])

  return {
    users,
    roles,
    groups,
    total,
    loading,
    error,
    search,
    setSearch,
    setUsers: setUsersState,
    setRoles,
    setGroups,
    setError,
    refresh,
  }
}
