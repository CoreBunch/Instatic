/** A docked plugin can borrow the Live surface without changing the author's saved view. */
const requests = new Map<symbol, string>()
const listeners = new Set<() => void>()
export const hasPluginLivePreview = () => requests.size > 0
export function subscribePluginLivePreview(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function requestPluginLivePreview(pluginId: string) {
  const key = Symbol()
  requests.set(key, pluginId)
  if (requests.size === 1) notifyListeners()
  return () => {
    if (requests.delete(key) && !requests.size) notifyListeners()
  }
}

export function clearPluginLivePreviews(pluginId?: string) {
  if (!requests.size) return
  for (const [key, owner] of requests) {
    if (pluginId === undefined || owner === pluginId) requests.delete(key)
  }
  if (!requests.size) notifyListeners()
}

function notifyListeners() {
  for (const listener of listeners) listener()
}
