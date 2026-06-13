import { strFromU8, unzipSync } from 'fflate'
import {
  parsePluginManifest,
} from '@core/plugins/manifest'
import { assertSandboxSafe } from '@core/plugins/sandboxScan'
import type { PluginManifest } from '@core/plugin-sdk'

const SAFE_PACKAGE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/
const BINARY_EXTENSIONS = /\.(png|jpe?g|webp|svg|gif|ico|woff2?|ttf|otf)$/i

interface PluginPackage {
  manifest: PluginManifest
  /**
   * Files inside the plugin zip, keyed by package-relative path. Text
   * entrypoints (JS / JSON / SVG) are stored as `string`; binary assets
   * (PNG / JPG / WEBP / fonts) as `Uint8Array`. The install handler
   * writes them to disk based on the value type.
   */
  files: Record<string, string | Uint8Array>
}

function assertSafePackagePath(path: string): void {
  if (!SAFE_PACKAGE_PATH.test(path)) {
    throw new Error(`Unsafe plugin package path "${path}"`)
  }
}

function isBinaryPath(path: string): boolean {
  // SVG is text-based but tools sometimes emit a BOM or invalid UTF-8.
  // We only treat truly binary formats as binary; SVG stays text so it
  // can be inspected/sanitised via existing string-based tooling.
  return BINARY_EXTENSIONS.test(path) && !/\.svg$/i.test(path)
}

export async function readPluginPackage(file: File): Promise<PluginPackage> {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const files: Record<string, string | Uint8Array> = {}

  for (const [path, bytes] of Object.entries(archive)) {
    if (path.endsWith('/')) continue
    assertSafePackagePath(path)
    files[path] = isBinaryPath(path) ? bytes : strFromU8(bytes)
  }

  const manifestText = files['plugin.json']
  if (typeof manifestText !== 'string') throw new Error('Plugin package is missing plugin.json')

  // parsePluginManifest is a TypeBox schema validator — it accepts unknown
  // and throws on shape mismatch. Safe boundary.
  const manifest = parsePluginManifest(JSON.parse(manifestText))
  const entrypoints = [
    ...Object.values(manifest.entrypoints ?? {}),
    ...manifest.adminPages.flatMap((page) =>
      page.content.kind === 'app' ? [page.content.entry] : [],
    ),
    ...(manifest.pack ? [manifest.pack.path] : []),
    ...(manifest.icon ? [manifest.icon] : []),
  ]

  for (const entry of entrypoints) {
    if (entry && !files[entry]) {
      throw new Error(`Missing plugin entrypoint "${entry}"`)
    }
  }

  // Install-time sandbox scan — defense-in-depth against bundles that
  // didn't go through `instatic-plugin build` (raw zips, third-party packagers).
  // The server entrypoint and module pack BOTH run inside the QuickJS
  // sandbox; both must be free of Node/Bun primitives.
  const serverEntry = manifest.entrypoints?.server
  if (serverEntry) {
    const serverSource = files[serverEntry]
    if (typeof serverSource === 'string') {
      assertSandboxSafe(serverSource, `${manifest.id}/${serverEntry}`)
    }
  }
  const modulesEntry = manifest.entrypoints?.modules
  if (modulesEntry) {
    const modulesSource = files[modulesEntry]
    if (typeof modulesSource === 'string') {
      assertSandboxSafe(modulesSource, `${manifest.id}/${modulesEntry}`)
    }
  }

  return { manifest, files }
}
