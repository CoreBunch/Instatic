/**
 * Stable route construction for site plugin backends. Pure string function —
 * frontend bundles INLINE it at build time (published pages have no host
 * import map; site plugin builds map '@instatic/plugin-sdk' through the
 * containment policy so this bundles in), while editor/admin bundles
 * resolve it through the host import map like the rest of the SDK. Keeping
 * the URL shape behind this helper preserves room to change it later.
 *
 *   import { sitePluginRoute } from '@instatic/plugin-sdk'
 *   await fetch(sitePluginRoute('newsletter', '/subscribe'), { method: 'POST' })
 *   // → /admin/api/cms/plugins/site.newsletter/runtime/subscribe
 */
export function sitePluginRoute(localId: string, path: string): string {
  const suffix = path.startsWith('/') ? path.slice(1) : path
  return `/admin/api/cms/plugins/site.${localId}/runtime/${suffix}`
}
