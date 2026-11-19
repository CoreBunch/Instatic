/**
 * Plugin loop sources as the editor sees them.
 *
 * The publish paths reach a plugin source through `loopSourceRegistry`, whose
 * shim runs the plugin's `fetch` in its worker. The editor runs in another
 * process and needs two more things: the list of sources plugins registered
 * (so the Loop module's Source picker can offer them), and sample items for
 * the canvas.
 *
 * Sample items come from the plugin's `preview()` and never from `fetch()`.
 * A source's `fetch` may hold data the person editing a page has no right to
 * read (every subscription, every customer); `preview` is sample data by
 * contract, and it is told nothing about a visitor or a member.
 */

import {
  LOOP_PREVIEW_MAX_BYTES,
  LoopSourcePreviewItemsSchema,
  type RemoteLoopSource,
} from '@core/loops/descriptorSchema'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopItem } from '@core/loops/types'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { hostPlugins } from './registry'
import { runLoopPreviewInWorker } from './rpc'

/** Every loop source a running plugin has registered, with its owner. */
export function listPluginLoopSources(): RemoteLoopSource[] {
  const sources: RemoteLoopSource[] = []
  for (const entry of hostPlugins.values()) {
    for (const { sourceId, pluginId } of entry.loopSources) {
      const source = loopSourceRegistry.get(sourceId)
      if (!source) continue
      sources.push({
        id: source.id,
        label: source.label,
        ...(source.description !== undefined ? { description: source.description } : {}),
        filterSchema: source.filterSchema,
        orderByOptions: source.orderByOptions,
        fields: source.fields,
        ...(source.requestDependent ? { requestDependent: true } : {}),
        ...(source.perVisitor ? { perVisitor: true } : {}),
        provider: { pluginId, pluginName: entry.manifest.name },
      })
    }
  }
  return sources
}

export type PluginLoopPreview =
  | { status: 'ok'; items: LoopItem[] }
  | { status: 'unknown-source' }
  | { status: 'failed'; error: string }

function owningPluginId(sourceId: string): string | null {
  for (const entry of hostPlugins.values()) {
    if (entry.loopSources.some((source) => source.sourceId === sourceId)) return entry.manifest.id
  }
  return null
}

/**
 * Ask a plugin source for sample items. The plugin is handed the loop's
 * filters and a limit, nothing else. Its answer is checked item by item and
 * capped in count and size before it leaves the host.
 */
export async function previewPluginLoopSource(
  sourceId: string,
  options: { filters: Record<string, unknown>; limit: number },
): Promise<PluginLoopPreview> {
  const pluginId = owningPluginId(sourceId)
  if (!pluginId) return { status: 'unknown-source' }

  let result: Awaited<ReturnType<typeof runLoopPreviewInWorker>>
  try {
    result = await runLoopPreviewInWorker(pluginId, sourceId, {
      filters: options.filters,
      limit: options.limit,
    })
  } catch (err) {
    console.error(`[plugin:${pluginId}] loop source "${sourceId}" preview failed:`, err)
    return { status: 'failed', error: 'The plugin did not answer in time.' }
  }
  if (!result.ok) return { status: 'failed', error: result.error }

  const items = safeParseValue(LoopSourcePreviewItemsSchema, result.items.slice(0, options.limit))
  if (!items.ok) {
    return {
      status: 'failed',
      error: 'preview() must return items shaped { id: string, fields: { … } }.',
    }
  }
  if (JSON.stringify(items.value).length > LOOP_PREVIEW_MAX_BYTES) {
    return { status: 'failed', error: 'preview() returned more data than a preview may carry.' }
  }
  return { status: 'ok', items: items.value }
}
