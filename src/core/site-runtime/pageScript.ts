/**
 * Page script — the script asset the God Mode JS panel edits for a page.
 *
 * A page script is an ordinary `SiteFile{type:'script'}` whose runtime scope
 * targets exactly one page (`{ type: 'pages', pageIds: [pageId] }`). Nothing
 * else marks it: it shows up in the Explorer Code tab, its settings stay
 * editable there, and it rides the normal build/inject pipeline. Created
 * lazily on the first edit at `scripts/pages/<slug>.js`.
 */
import type { SiteFile } from '@core/files/schemas'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG } from './runtimeConfig'
import type { SiteRuntimeConfig, SiteScriptRuntimeConfig } from './schemas'

const PAGE_SCRIPTS_DIR = 'scripts/pages'

export function pageScriptRuntimeConfig(pageId: string): SiteScriptRuntimeConfig {
  return { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, scope: { type: 'pages', pageIds: [pageId] } }
}

function isPageScriptConfig(config: SiteScriptRuntimeConfig | undefined, pageId: string): boolean {
  return config?.scope.type === 'pages'
    && config.scope.pageIds.length === 1
    && config.scope.pageIds[0] === pageId
}

/**
 * The script scoped to exactly `pageId`, or null. When several qualify the
 * one that loads first wins (ascending priority, then path) — the same order
 * the runtime uses.
 */
export function findPageScript(
  files: readonly SiteFile[],
  runtime: SiteRuntimeConfig,
  pageId: string,
): SiteFile | null {
  const candidates = files
    .filter((file) => file.type === 'script' && isPageScriptConfig(runtime.scripts[file.id], pageId))
    .map((file) => ({ file, priority: runtime.scripts[file.id]?.priority ?? DEFAULT_SCRIPT_RUNTIME_CONFIG.priority }))
    .sort((a, b) => (a.priority - b.priority) || a.file.path.localeCompare(b.file.path))
  return candidates[0]?.file ?? null
}

/** `scripts/pages/<slug>.js`, stepping past any file already at that path. */
export function pageScriptPath(files: readonly SiteFile[], page: { slug: string }): string {
  const base = `${PAGE_SCRIPTS_DIR}/${page.slug.trim() || 'index'}`
  const taken = new Set(files.map((file) => file.path))
  if (!taken.has(`${base}.js`)) return `${base}.js`
  let suffix = 2
  while (taken.has(`${base}-${suffix}.js`)) suffix += 1
  return `${base}-${suffix}.js`
}
