/**
 * Cache-buster for plugin entrypoint dynamic imports.
 *
 * Why this exists at all: the browser's module loader caches each
 * `/uploads/.../<entry>.js` URL forever within a session. When
 * `instatic-plugin dev` rewrites a plugin file, or the user re-uploads a
 * plugin, a soft editor reload would still execute the stale module.
 * Appending a `?v=<key>` query string forces the browser to refetch.
 *
 * The cache key has two modes:
 *
 *   • DEV (`import.meta.env.DEV`) — `Date.now()`. Every editor mount
 *     gets a fresh fetch so `instatic-plugin dev`'s file-watch reloads
 *     immediately replace the running plugin module. Cost: zero
 *     browser cache reuse, but plugin bundles are tiny in dev.
 *
 *   • PROD — `<version>-<updatedAt>`. Stable per plugin install, so
 *     repeat editor visits hit the browser cache. Changes when the
 *     plugin is upgraded (new version) or re-installed (new updatedAt).
 *
 * Returns the URL with the buster appended (or the original URL if no
 * cache key is provided — useful for tests that want exact URL matches).
 */
interface PluginCacheKeyInput {
  version: string
  updatedAt: string
}

export function pluginCacheKey(plugin: PluginCacheKeyInput): string {
  return `${plugin.version}-${plugin.updatedAt}`
}

export function withPluginCacheBuster(url: string, cacheKey: string): string {
  if (!cacheKey) return url
  const sep = url.includes('?') ? '&' : '?'
  // `import.meta.env.DEV` is set to `true` by Vite at dev-build time
  // and `false` after `vite build`. Falls back to `false` if undefined
  // (e.g. when this code runs in tests outside the Vite pipeline).
  const inDev =
    typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true
  const v = inDev ? Date.now().toString() : cacheKey
  return `${url}${sep}v=${encodeURIComponent(v)}`
}
