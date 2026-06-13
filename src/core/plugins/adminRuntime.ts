/**
 * Admin-side runtime helpers for loading plugin admin app modules.
 *
 *   • `loadPluginAdminAppComponent(page)` — dynamic-imports the plugin's
 *     admin app entrypoint and returns its default-exported React component
 *     (a `PluginAdminAppComponent` from `definePluginAdminApp`).
 *   • `buildPluginRoutesHelper(pluginId)` — produces the fetch + json
 *     helpers handed to plugin code through the host-hooks `PluginContext`.
 *
 * Plugin admin apps used to receive a curated `api` and `ui` namespace
 * via render-function arguments. That layer is gone — plugins now write
 * real React components and pull editor / settings / route helpers from
 * `@instatic/host-hooks` (which the host populates per-mount via
 * `PluginContext`).
 */
import type { TSchema, Static } from '@sinclair/typebox'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import type {
  PluginAdminAppComponent,
  PluginAdminPageRoute,
} from '@core/plugin-sdk'
import { withPluginCacheBuster } from './cacheBuster'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/**
 * Loaded plugin admin app module shape — the `default` export is the
 * `PluginAdminAppComponent` returned by `definePluginAdminApp`.
 */
type LoadedAdminAppModule = { default: PluginAdminAppComponent }

export type PluginAdminAppImport = (url: string, cacheKey?: string) => Promise<LoadedAdminAppModule>

const defaultImportModule: PluginAdminAppImport = async (url, cacheKey) =>
  await import(/* @vite-ignore */ withPluginCacheBuster(url, cacheKey ?? '')) as LoadedAdminAppModule

function pluginAdminAssetUrl(assetPath: string, entrypoint: string): string {
  return `${assetPath.replace(/\/+$/g, '')}/${entrypoint.replace(/^\/+/g, '')}`
}

function runtimePath(pluginId: string, path: string): string {
  const normalized = path.trim().replace(/^\/+/g, '')
  return `/admin/api/cms/plugins/${encodeURIComponent(pluginId)}/runtime/${normalized}`
}

interface PluginRoutesHelper {
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  json: <T extends TSchema>(path: string, schema: T, init?: RequestInit) => Promise<Static<T>>
}

/**
 * Build the plugin-scoped HTTP routes helper. Stable signature, suitable
 * for handing through `PluginContext` so plugin code can call
 * `usePluginRoutes()` and reach its own server entrypoint without
 * constructing URLs manually.
 */
export function buildPluginRoutesHelper(
  pluginId: string,
  fetchImpl: FetchLike = defaultFetch,
): PluginRoutesHelper {
  return {
    fetch(path, init) {
      return fetchImpl(runtimePath(pluginId, path), {
        credentials: 'include',
        ...init,
      })
    },
    async json<T extends TSchema>(path: string, schema: T, init?: RequestInit): Promise<Static<T>> {
      const res = await fetchImpl(runtimePath(pluginId, path), {
        credentials: 'include',
        ...init,
      })
      if (!res.ok) throw new Error(`Plugin route failed with ${res.status}`)
      return await parseJsonResponse(res, schema)
    },
  }
}

/**
 * Resolve a plugin admin page's entrypoint module via dynamic `import()`.
 * Throws if the module doesn't default-export a `PluginAdminAppComponent`.
 *
 * `cacheKey` is the plugin's `<version>-<updatedAt>` — appended to the
 * import URL via `withPluginCacheBuster` so the browser refetches when
 * the plugin is upgraded or re-installed but caches stably otherwise.
 */
export async function loadPluginAdminAppComponent(
  page: PluginAdminPageRoute,
  importModule: PluginAdminAppImport = defaultImportModule,
  cacheKey?: string,
): Promise<{ Component: PluginAdminAppComponent }> {
  if (page.content.kind !== 'app') {
    throw new Error('Plugin admin app loader requires app page content')
  }
  // App pages are unsandboxed plugin JavaScript imported into the admin
  // window — the host refuses to import the module without the explicit
  // `editor.code` grant. The thrown error surfaces in the page body via
  // PluginAppPage's error state, so an ungranted page is a visible
  // refusal rather than a silent skip.
  if (!page.pluginGrantedPermissions.includes('editor.code')) {
    throw new Error(
      `Plugin admin app "${page.pluginId}:${page.id}" requires the "editor.code" permission, ` +
      `which is not granted. App pages run unsandboxed in the admin window.`,
    )
  }
  if (!page.content.assetPath) {
    throw new Error(`Plugin admin app "${page.pluginId}:${page.id}" is missing an asset path`)
  }
  const mod = await importModule(
    pluginAdminAssetUrl(page.content.assetPath, page.content.entry),
    cacheKey,
  )
  const Component = (mod as { default?: unknown }).default
  if (typeof Component !== 'function' && typeof Component !== 'object') {
    throw new Error(
      `Plugin admin app "${page.pluginId}:${page.id}" must default-export a React component (definePluginAdminApp).`,
    )
  }
  return { Component: Component as PluginAdminAppComponent }
}
