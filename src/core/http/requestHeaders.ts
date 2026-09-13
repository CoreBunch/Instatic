/**
 * Ambient request headers — headers every admin request carries without each
 * call site naming them. Today that is the branch header: the admin shell
 * registers a provider that reads the active branch, and `apiRequest` plus
 * the few hand-rolled `fetch` sites (streams, uploads) merge the provider's
 * headers into their own. Explicit per-call headers always win.
 */

export type RequestHeaderProvider = () => Record<string, string>

let provider: RequestHeaderProvider | null = null

export function registerRequestHeaderProvider(next: RequestHeaderProvider | null): void {
  provider = next
}

/** The ambient headers at this moment — `{}` before the shell registers a provider. */
export function ambientRequestHeaders(): Record<string, string> {
  return provider ? provider() : {}
}

/**
 * Merge the ambient headers underneath `init.headers`. For the hand-rolled
 * `fetch` sites that cannot go through `apiRequest` (NDJSON streams, XHR
 * uploads, FormData bodies with their own content type). The caller's header
 * container keeps its shape: a plain object stays a plain object.
 */
export function withAmbientHeaders(init: RequestInit = {}): RequestInit {
  const ambient = ambientRequestHeaders()
  if (Object.keys(ambient).length === 0) return init
  const own = init.headers
  if (own instanceof Headers) {
    const merged = new Headers(own)
    for (const [name, value] of Object.entries(ambient)) {
      if (!merged.has(name)) merged.set(name, value)
    }
    return { ...init, headers: merged }
  }
  if (Array.isArray(own)) {
    const present = new Set(own.map(([name]) => name.toLowerCase()))
    const extra = Object.entries(ambient).filter(([name]) => !present.has(name.toLowerCase()))
    return { ...init, headers: [...own, ...extra] }
  }
  return { ...init, headers: { ...ambient, ...(own ?? {}) } }
}
