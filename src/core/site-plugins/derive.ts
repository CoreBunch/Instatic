/**
 * Site plugin manifest derivation — turns the author-owned draft
 * `plugin.json` plus the folder convention into a full runtime
 * `PluginManifest`, validated through the REAL parser
 * (`parsePluginManifest`) — the same contract a zip package has.
 *
 * Field ownership (design: docs/features/site-plugins.md):
 *   author writes  → name, description, permissions, contentAccess,
 *                    settings, resources, adminPages, frontend assets,
 *                    networkAllowedHosts, marketplace metadata
 *   build derives  → id (site.<local-id>), version (1.0.<n>+<hash>),
 *                    apiVersion (host PLUGIN_API_VERSION), entrypoints
 *                    (folder convention), assetBasePath (pinned shape),
 *                    pack (pack/site.json presence), built asset paths
 */
import type { SiteFile } from '@core/files/schemas'
import type { PluginManifest } from '@core/plugin-sdk'
import { PLUGIN_API_VERSION } from '@core/plugin-sdk'
import { parsePluginManifest } from '@core/plugins/manifest'
import { safeParseJson } from '@core/utils/jsonValidate'
import {
  SITE_PLUGIN_DERIVED_FIELDS,
  SitePluginDraftManifestSchema,
  sitePluginFolder,
  sitePluginIdFromLocalId,
  type SitePluginDraftManifest,
} from './schemas'

const VERSION_PATTERN = /^1\.0\.(\d+)\+[0-9a-f]+$/

/**
 * Deterministic, order-independent fingerprint over the manifest plus every
 * file under the site plugin folder — the `+<hash>` component of the
 * generated version, used to skip no-op rebuilds. FNV-1a (64-bit, pure JS)
 * rather than a crypto hash so this module stays browser-safe (the IDE
 * computes draft-changed state client-side); the hash guards a
 * skip-own-rebuild optimization, not a trust boundary.
 */
export function computeSitePluginContentHash(files: readonly SiteFile[]): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  const update = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      h ^= BigInt(text.charCodeAt(i) & 0xff)
      h = (h * prime) & mask
      h ^= BigInt(text.charCodeAt(i) >> 8)
      h = (h * prime) & mask
    }
  }
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    update(file.path)
    update('\0')
    update(file.content ?? '')
    update('\0')
  }
  return h.toString(16).padStart(16, '0')
}

/**
 * Monotonic generated version: `1.0.<buildCounter>+<contentHash>`. Passes
 * the manifest's SEMVERISH_PATTERN, keeps `migrate({ fromVersion })`
 * ordered, and carries the source fingerprint for skip-rebuild.
 */
export function nextSitePluginVersion(previousVersion: string | null, contentHash: string): string {
  const previous = previousVersion ? VERSION_PATTERN.exec(previousVersion) : null
  const counter = previous ? Number(previous[1]) + 1 : 1
  return `1.0.${counter}+${contentHash}`
}

/** The content hash a stored generated version carries, or null. */
export function contentHashOfVersion(version: string | null | undefined): string | null {
  if (!version) return null
  const match = /\+([0-9a-f]+)$/.exec(version)
  return match?.[1] ?? null
}

export interface DeriveSitePluginManifestInput {
  localId: string
  draftManifestJson: string
  /** Every 'plugin' file under plugins/<localId>/ (paths intact). */
  files: readonly SiteFile[]
  /** The currently active generated version, or null on first build. */
  previousVersion: string | null
  contentHash: string
}

function parseDraftManifest(localId: string, raw: string): SitePluginDraftManifest {
  const result = safeParseJson(raw, SitePluginDraftManifestSchema)
  if (!result.ok) {
    // additionalProperties:false violations usually mean an author-set
    // derived field — name them so a copy-pasted manifest fails helpfully.
    // Union failures get a shape-specific hint: "Expected union value" alone
    // sends authors (and agents) guessing at field names.
    throw new Error(
      `plugin.json for "${localId}" is invalid — ${result.error.message}.` +
        adminPageContentHint(result.error.message) +
        ` Note: ${SITE_PLUGIN_DERIVED_FIELDS.join(', ')} are derived by the build and must not be set.`,
      { cause: result.error },
    )
  }
  return result.value
}

/**
 * The adminPages content union is the manifest's most-guessed shape. When
 * that exact path fails, spell out the allowed variants instead of leaving
 * TypeBox's opaque "Expected union value".
 */
function adminPageContentHint(errorMessage: string): string {
  if (!/\/adminPages\/\d+\/content/.test(errorMessage)) return ''
  return (
    ' adminPages[].content must be one of:' +
    ' { "kind": "markdown", "body": "…", "heading"? },' +
    ' { "kind": "resource", "heading": "…", "resource": "<resource-slug from resources[]>" },' +
    ' { "kind": "map", "heading": "…", "pins"? },' +
    ' { "kind": "app", "heading": "…", "entry": "<built frontend asset>" }.'
  )
}

export function deriveSitePluginManifest(input: DeriveSitePluginManifestInput): PluginManifest {
  const draft = parseDraftManifest(input.localId, input.draftManifestJson)

  const id = sitePluginIdFromLocalId(input.localId)
  const version = nextSitePluginVersion(input.previousVersion, input.contentHash)
  const folder = sitePluginFolder(input.localId)
  const relativePaths = new Set(
    input.files
      .filter((f) => f.path.startsWith(folder))
      .map((f) => f.path.slice(folder.length)),
  )

  const entrypoints: Record<string, string> = {}
  const hasEntry = (base: string): boolean =>
    ['ts', 'tsx', 'js', 'mjs'].some(
      (ext) => relativePaths.has(`${base}.${ext}`) || relativePaths.has(`${base}/index.${ext}`),
    )
  if (hasEntry('server')) entrypoints['server'] = 'server/index.js'
  if (hasEntry('editor')) entrypoints['editor'] = 'editor/index.js'
  if (
    [...relativePaths].some(
      (p) => p.startsWith('modules/') && /\.(tsx?|m?js)$/.test(p) && !p.startsWith('modules/index.'),
    )
  ) {
    entrypoints['modules'] = 'modules/index.js'
  }

  // Frontend asset declarations reference SOURCE paths; the build emits
  // `.js` bundles for `.ts`/`.tsx`/`.mjs` sources — rewrite so the stored
  // manifest points at what actually exists in the package.
  const frontend = draft.frontend
    ? {
        assets: draft.frontend.assets.map((asset) => {
          if (asset.kind === 'script') {
            return { ...asset, src: asset.src.replace(/\.(tsx?|mjs)$/, '.js') }
          }
          return asset
        }),
      }
    : undefined

  // Validate through the REAL parser — the same contract a zip has.
  return parsePluginManifest({
    ...draft,
    ...(frontend ? { frontend } : {}),
    id,
    version,
    apiVersion: PLUGIN_API_VERSION,
    entrypoints,
    assetBasePath: `/uploads/plugins/${id}/${version}`,
    ...(relativePaths.has('pack/site.json') ? { pack: { path: 'pack/site.json' } } : {}),
  })
}
