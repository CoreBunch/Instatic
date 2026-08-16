import type { AdminWorkspace } from '@admin/workspace'

/**
 * Mirrors the `section` each route hands `<AdminEntry>` in `router.tsx`. Falls
 * back to `'dashboard'` (not `'site'`) for anything unrecognized, matching the
 * router's own catch-all (`/admin/*` → `/admin/dashboard`) — a stray/unknown
 * path is the admin home, not the Site editor. Getting this right matters
 * beyond navigation labels: `filterCommands` gates every `site`-scoped
 * command (layers, panels, framework, preview, …) on `ctx.workspace === 'site'`,
 * so misclassifying, say, `/admin/dashboard` as `'site'` would both surface
 * those commands where there's no open editor to run them against AND make a
 * command like "Take the editor tour" think it's already on the Site
 * workspace instead of queuing its cross-workspace navigate.
 *
 * Lives in its own `.ts` file (not inline in `SpotlightRoot.tsx`) so it's a
 * plain importable/testable export — same reason `spotlightContext.ts` is
 * split out: `react-refresh/only-export-components` wants `.tsx` files to
 * only export components.
 */
export function workspaceFromPathname(pathname: string): AdminWorkspace {
  if (pathname.startsWith('/admin/content')) return 'content'
  if (pathname.startsWith('/admin/data')) return 'data'
  if (pathname.startsWith('/admin/media')) return 'media'
  // Plugin *pages* (`/admin/plugins/:pluginId/:pageId`) are a distinct
  // workspace from the plugin manager list (`/admin/plugins`) — check the
  // more specific path first.
  if (/^\/admin\/plugins\/[^/]+\/[^/]+/.test(pathname)) return 'pluginPage'
  if (pathname.startsWith('/admin/plugins')) return 'plugins'
  if (pathname.startsWith('/admin/users')) return 'users'
  if (pathname.startsWith('/admin/ai')) return 'ai'
  if (pathname.startsWith('/admin/account')) return 'account'
  if (pathname.startsWith('/admin/site')) return 'site'
  return 'dashboard'
}
