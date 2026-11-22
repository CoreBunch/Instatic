/**
 * pluginPackage — recognise a plugin package dropped into the site importer.
 *
 * A plugin is a zip with `plugin.json` at its root. Ingested as a static site
 * it has no pages, so its frontend CSS would import as loose stylesheets and
 * the plugin itself would never install. The wizard checks for one right
 * after ingestion and points the owner at the Plugins page instead.
 *
 * `ingestInput` strips a single shared top-level folder, so a package zipped
 * as `my-plugin/plugin.json` is recognised the same way.
 */

import { Type } from '@sinclair/typebox'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import type { FileMap } from './types'

const PLUGIN_MANIFEST_PATH = 'plugin.json'

/** Only the display name is read here; the Plugins page validates the manifest. */
const PluginPackageNameSchema = Type.Object({ name: Type.Optional(Type.String()) })

interface DetectedPluginPackage {
  /** The manifest's `name`, or null when the manifest is unreadable or unnamed. */
  name: string | null
}

export function detectPluginPackage(fileMap: FileMap): DetectedPluginPackage | null {
  const manifest = fileMap.files[PLUGIN_MANIFEST_PATH]
  if (!manifest) return null
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(manifest.bytes)
  const name = parseJsonWithFallback(raw, PluginPackageNameSchema, {}).name?.trim()
  return { name: name ? name : null }
}
