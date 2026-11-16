/**
 * AdminSectionNavigation — the row of section links shown inside the
 * editor toolbar (Site · Content · Plugins · Users · …plugin pages).
 *
 * Lives next to the toolbar styles it consumes so both the heavy
 * AdminCanvasLayout (Site), AdminWorkspaceCanvasLayout (Content / Data /
 * Media), and the lightweight AdminPageLayout (Plugins / Users / Account /
 * plugin pages) can share it without one layout pulling another layout's
 * module graph in.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react'
import { ArticleSolidIcon } from 'pixel-art-icons/icons/article-solid'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { DashboardSolidIcon } from 'pixel-art-icons/icons/dashboard-solid'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import { listCmsPlugins } from '@core/persistence/cmsPlugins'
import type { CmsCurrentUser } from '@core/persistence'
import type { PluginAdminPageRoute } from '@core/plugin-sdk'
import { Link } from '@admin/lib/routing'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { canAccessWorkspace } from '@admin/access'
import {
  getPluginsInErrorCount,
  subscribePluginIssues,
} from '@admin/pages/plugins/utils/pluginIssuesStore'
import { CMS_PLUGINS_CHANGED_EVENT } from '@admin/pages/plugins/utils/pluginEvents'
import type { AdminWorkspace } from '@admin/workspace'
import { cn } from '@ui/cn'
import { AdminNavMoreMenu } from './AdminNavMoreMenu'
import { useAdminRouteNavigation } from './useAdminRouteNavigation'
import { useFittingEntryCount } from './useFittingEntryCount'
import type { AdminNavEntry } from './navEntry'
import toolbarStyles from '@site/toolbar/Toolbar.module.css'

/**
 * Pixel-art icon used inside an admin nav link. Sized to match the
 * 11px nav-label cap-height — the 13px box leaves the icon visually
 * balanced with the text without crowding the 28px button track.
 */
const NAV_ICON_SIZE = 13

interface AdminSectionNavigationProps {
  section: AdminWorkspace
  currentUser?: CmsCurrentUser | null
  onWorkspaceNavigateStart?: () => unknown
}

// Session-scoped cache of the plugin admin pages list. Without it the
// nav re-fetched (and briefly emptied) every time `AdminSectionNavigation`
// re-mounted — typical case: navigating between admin layout families
// unmounts the previous Toolbar, which drops this state and reseeds from
// `[]` while the next fetch lands.
// Caching at module scope means the existing pages render immediately
// on remount; the SSE / CMS_PLUGINS_CHANGED_EVENT path still refreshes
// when plugins genuinely change.
let cachedPluginPages: PluginAdminPageRoute[] = []
const cachedPluginPagesListeners = new Set<() => void>()
function setCachedPluginPages(next: PluginAdminPageRoute[]): void {
  const unchanged =
    cachedPluginPages.length === next.length &&
    cachedPluginPages.every((page, index) => page.route === next[index]?.route)
  if (unchanged) return
  cachedPluginPages = next
  for (const listener of cachedPluginPagesListeners) listener()
}

export function AdminSectionNavigation({
  section,
  currentUser,
  onWorkspaceNavigateStart,
}: AdminSectionNavigationProps) {
  // Hydrate from the session cache so the nav links don't flash empty
  // on every re-mount.
  const [pluginPages, setPluginPages] = useState<PluginAdminPageRoute[]>(
    () => cachedPluginPages,
  )
  const sessionUser = useCurrentAdminUser()
  const effectiveUser = currentUser ?? sessionUser ?? null
  const unrestricted = !effectiveUser
  const canAccess = (workspace: AdminWorkspace) => unrestricted || canAccessWorkspace(effectiveUser, workspace)
  const canAccessPlugins = canAccess('plugins')

  useEffect(() => {
    let cancelled = false

    // Subscribe to the module-level cache so other mounts (or the
    // CMS_PLUGINS_CHANGED refresh below) update every visible
    // navigation in lockstep.
    function onCacheChange(): void {
      if (!cancelled) setPluginPages(cachedPluginPages)
    }
    cachedPluginPagesListeners.add(onCacheChange)

    async function loadPluginPages() {
      if (!canAccessPlugins) {
        setCachedPluginPages([])
        return
      }
      try {
        const payload = await listCmsPlugins()
        if (!cancelled) {
          setCachedPluginPages(payload.adminPages)
        }
      } catch {
        // Navigation remains usable when plugins cannot be loaded.
      }
    }

    function refreshPluginPages() {
      void loadPluginPages()
    }

    // Only fetch when the cache is empty (first session mount or after
    // a sign-out clear) or on CMS_PLUGINS_CHANGED. Subsequent
    // navigations hit the cached list instantly.
    if (cachedPluginPages.length === 0) {
      refreshPluginPages()
    }
    window.addEventListener(CMS_PLUGINS_CHANGED_EVENT, refreshPluginPages)
    return () => {
      cancelled = true
      cachedPluginPagesListeners.delete(onCacheChange)
      window.removeEventListener(CMS_PLUGINS_CHANGED_EVENT, refreshPluginPages)
    }
  }, [canAccessPlugins])

  const pluginIssuesCount = useSyncExternalStore(
    subscribePluginIssues,
    getPluginsInErrorCount,
    getPluginsInErrorCount,
  )
  const rowRef = useRef<HTMLElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const navigateTo = useAdminRouteNavigation(onWorkspaceNavigateStart)

  const firstPartyEntries: Array<AdminNavEntry & { workspace: AdminWorkspace }> = [
    { workspace: 'dashboard', key: 'dashboard', to: '/admin/dashboard', label: 'Dashboard', icon: <DashboardSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />, active: section === 'dashboard' },
    { workspace: 'site', key: 'site', to: '/admin/site', label: 'Site', icon: <LayoutSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />, active: section === 'site' || section === 'branchReview' },
    { workspace: 'content', key: 'content', to: '/admin/content', label: 'Content', icon: <ArticleSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />, active: section === 'content' },
    { workspace: 'data', key: 'data', to: '/admin/data', label: 'Data', icon: <DatabaseSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />, active: section === 'data' },
    { workspace: 'media', key: 'media', to: '/admin/media', label: 'Media', icon: <ImagesSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />, active: section === 'media' },
    {
      workspace: 'plugins', key: 'plugins', to: '/admin/plugins', label: 'Plugins',
      icon: <PackageSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />,
      active: section === 'plugins',
      badge: pluginIssuesCount > 0 ? <PluginsErrorDot count={pluginIssuesCount} /> : undefined,
    },
    { workspace: 'ai', key: 'ai', to: '/admin/ai', label: 'AI', icon: <AiBoxSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />, active: section === 'ai' },
    { workspace: 'users', key: 'users', to: '/admin/users', label: 'Users', icon: <UsersSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />, active: section === 'users' },
  ]
  const entries: AdminNavEntry[] = [
    ...firstPartyEntries.filter((entry) => canAccess(entry.workspace)),
    ...(canAccessPlugins ? pluginPages : []).map((page) => ({
      key: `${page.pluginId}:${page.id}`,
      to: page.route,
      label: page.navLabel ?? page.title,
      icon: <PackageSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />,
      // A plugin page has no workspace of its own; it is never the "current
      // section" label, only a link.
      active: false,
    })),
  ]

  // Plugins add entries, so the row has no upper bound. Whatever does not fit
  // moves into a trailing "More" menu; the row itself never widens the toolbar.
  const fit = useFittingEntryCount(rowRef, moreRef, entries.length)
  const overflowed = entries.slice(fit.count)

  return (
    <nav ref={rowRef} aria-label="Admin sections" className={toolbarStyles.adminNavigation}>
      {entries.map((entry, index) => (
        <span
          key={entry.key}
          data-admin-nav-entry=""
          className={cn(
            toolbarStyles.adminNavEntry,
            index >= fit.count && toolbarStyles.adminNavOutOfRow,
          )}
        >
          <NavItem entry={entry} onNavigate={navigateTo} />
        </span>
      ))}
      <AdminNavMoreMenu
        triggerRef={moreRef}
        entries={overflowed}
        left={fit.moreLeft}
        onNavigate={navigateTo}
      />
    </nav>
  )
}

/**
 * One entry in the row: the non-clickable `activeSection` label when the user
 * is already on that workspace, otherwise a soft-navigating link.
 */
function NavItem({ entry, onNavigate }: { entry: AdminNavEntry; onNavigate: (to: string) => void }) {
  if (entry.active) {
    return (
      <span className={toolbarStyles.activeSection}>
        {entry.icon}
        <span>{entry.label}</span>
        {entry.badge}
      </span>
    )
  }

  function followLink(event: MouseEvent<HTMLAnchorElement>) {
    // Modifier keys / non-primary buttons / target=_blank → let the native
    // <a> behaviour run (open-in-new-tab, etc.).
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.currentTarget.target
    ) {
      return
    }
    event.preventDefault()
    onNavigate(entry.to)
  }

  return (
    <Link className={toolbarStyles.adminLink} to={entry.to} onClick={followLink}>
      {entry.icon}
      <span>{entry.label}</span>
      {entry.badge}
    </Link>
  )
}

/**
 * Red dot next to the Plugins label while any plugin is in `error` lifecycle
 * state. Fed by the live SSE-driven `pluginIssuesStore`, so a plugin crashing
 * while the user is on (say) the Content page lights up in real time.
 */
function PluginsErrorDot({ count }: { count: number }) {
  return (
    <output
      className={toolbarStyles.pluginsErrorDot}
      aria-label={`${count} plugin${count === 1 ? '' : 's'} in error state`}
      title={`${count} plugin${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} attention`}
    />
  )
}
