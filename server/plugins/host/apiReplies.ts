/**
 * Host replies for plugin-originated api-call messages.
 *
 * Replies are intentionally separate from workerPool so host handlers and the
 * API dispatcher do not need to import the worker transport module.
 */

import { workers } from './workerState'

export function replyApiOk(pluginId: string, correlationId: string, value?: unknown): void {
  // Reply must go to the same worker that issued the api-call. With per-plugin
  // workers we pick by pluginId; if that worker has been terminated (e.g. a
  // crash race during the round-trip) we silently drop because there is no
  // receiver left.
  const worker = workers.get(pluginId)
  if (!worker) return
  worker.postMessage({ kind: 'api-reply', correlationId, ok: true, value })
}

export function replyApiError(pluginId: string, correlationId: string, message: string, code?: string): void {
  const worker = workers.get(pluginId)
  if (!worker) return
  worker.postMessage({
    kind: 'api-reply',
    correlationId,
    ok: false,
    error: message,
    ...(code !== undefined ? { code } : {}),
  })
}
