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
import { useEffect, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
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
import { Link, useLocation } from '@admin/lib/routing'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { canAccessWorkspace } from '@admin/access'
import {
  getPluginsInErrorCount,
  subscribePluginIssues,
} from '@admin/pages/plugins/utils/pluginIssuesStore'
import { CMS_PLUGINS_CHANGED_EVENT } from '@admin/pages/plugins/utils/pluginEvents'
import type { AdminWorkspace } from '@admin/workspace'
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

  return (
    <>
      {canAccess('dashboard') && (
        <NavItem
          to="/admin/dashboard"
          icon={<DashboardSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Dashboard"
          active={section === 'dashboard'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('site') && (
        <NavItem
          to="/admin/site"
          icon={<LayoutSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Site"
          active={section === 'site' || section === 'branchReview'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('content') && (
        <NavItem
          to="/admin/content"
          icon={<ArticleSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Content"
          active={section === 'content'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('data') && (
        <NavItem
          to="/admin/data"
          icon={<DatabaseSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Data"
          active={section === 'data'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('media') && (
        <NavItem
          to="/admin/media"
          icon={<ImagesSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Media"
          active={section === 'media'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('plugins') && (
        <PluginsNavLink
          active={section === 'plugins'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('ai') && (
        <NavItem
          to="/admin/ai"
          icon={<AiBoxSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="AI"
          active={section === 'ai'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('users') && (
        <NavItem
          to="/admin/users"
          icon={<UsersSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Users"
          active={section === 'users'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccessPlugins && pluginPages.map((page) => (
        <AdminRouteLink
          key={`${page.pluginId}:${page.id}`}
          to={page.route}
          onNavigateStart={onWorkspaceNavigateStart}
        >
          <PackageSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />
          <span>{page.navLabel ?? page.title}</span>
        </AdminRouteLink>
      ))}
    </>
  )
}

/**
 * Single first-party admin nav slot. Renders the icon + label as the
 * non-clickable `activeSection` span when the user is already on that
 * workspace, otherwise as a soft-navigating `AdminRouteLink`.
 */
function NavItem({
  to,
  icon,
  label,
  active,
  onNavigateStart,
}: {
  to: string
  icon: ReactNode
  label: string
  active: boolean
  onNavigateStart?: () => unknown
}) {
  if (active) {
    return (
      <span className={toolbarStyles.activeSection}>
        {icon}
        <span>{label}</span>
      </span>
    )
  }
  return (
    <AdminRouteLink to={to} onNavigateStart={onNavigateStart}>
      {icon}
      <span>{label}</span>
    </AdminRouteLink>
  )
}

/**
 * Plugins nav link — renders a tiny red dot next to the label when any
 * plugin is currently in `error` lifecycle state. The dot is fed by the
 * live SSE-driven `pluginIssuesStore`, so a plugin crashing while the
 * user is on (say) the Content page lights up the badge in real time.
 */
function PluginsNavLink({
  active,
  onNavigateStart,
}: {
  active: boolean
  onNavigateStart?: () => unknown
}) {
  const issuesCount = useSyncExternalStore(
    subscribePluginIssues,
    getPluginsInErrorCount,
    getPluginsInErrorCount,
  )
  const dot = issuesCount > 0 ? (
    <output
      className={toolbarStyles.pluginsErrorDot}
      aria-label={`${issuesCount} plugin${issuesCount === 1 ? '' : 's'} in error state`}
      title={`${issuesCount} plugin${issuesCount === 1 ? '' : 's'} need${issuesCount === 1 ? 's' : ''} attention`}
    />
  ) : null

  if (active) {
    return (
      <span className={toolbarStyles.activeSection}>
        <PackageSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />
        <span>Plugins</span>
        {dot}
      </span>
    )
  }
  return (
    <AdminRouteLink to="/admin/plugins" onNavigateStart={onNavigateStart}>
      <PackageSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />
      <span>Plugins</span>
      {dot}
    </AdminRouteLink>
  )
}

/**
 * Soft-navigating admin nav link. Always rendered inside the admin Router
 * (the admin shell unconditionally mounts one), so we don't fork into a
 * router-vs-static branch — calling `useAdminNavigate` here is always safe.
 */
function AdminRouteLink({
  to,
  children,
  onNavigateStart,
}: {
  to: string
  children: ReactNode
  onNavigateStart?: () => unknown
}) {
  const navigate = useAdminNavigate()
  const location = useLocation()

  async function navigateToAdminRoute(event: MouseEvent<HTMLAnchorElement>) {
    // Modifier keys / non-primary buttons / target=_blank → let the native
    // <a> behaviour run (open-in-new-tab, etc.). Same-page clicks are a
    // no-op so the soft transition doesn't replay needlessly.
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

    if (location.pathname === to) return

    event.preventDefault()
    try {
      const result = onNavigateStart?.()
      if (isPromiseLike(result)) await result
      navigate(to)
    } catch (err) {
      console.error('[AdminSectionNavigation] Navigation start hook failed:', err)
    }
  }

  return (
    <Link className={toolbarStyles.adminLink} to={to} onClick={navigateToAdminRoute}>
      {children}
    </Link>
  )
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) return false
  if (!('then' in value)) return false
  return typeof (value as { then: unknown }).then === 'function'
}
