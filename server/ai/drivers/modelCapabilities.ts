import type {
  AiProvider,
  AiProviderCapabilities,
  AiResolvedCredential,
} from './types'

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000
const CAPABILITY_LOOKUP_TIMEOUT_MS = 10_000
const MAX_CACHE_ENTRIES_PER_DRIVER = 256

interface CapabilityCacheEntry {
  expiresAt: number
  value: AiProviderCapabilities
}

const capabilityCache = new WeakMap<AiProvider, Map<string, CapabilityCacheEntry>>()
const capabilityLookups = new WeakMap<AiProvider, Map<string, Promise<AiProviderCapabilities>>>()

/**
 * Resolve the selected model's runtime capabilities. Providers with
 * model-specific capability metadata own the authoritative lookup; the shared
 * layer bounds it with a short cache and de-duplicates concurrent requests.
 */
export async function resolveModelCapabilities(
  driver: AiProvider,
  credentials: AiResolvedCredential,
  modelId: string,
): Promise<AiProviderCapabilities> {
  const fallback = driver.capabilities(modelId)
  if (!driver.resolveCapabilities) return fallback

  const key = `${credentialRevisionKey(credentials)}\0${modelId}`
  const cache = mapFor(capabilityCache, driver)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  if (cached) cache.delete(key)

  const lookups = mapFor(capabilityLookups, driver)
  const existingLookup = lookups.get(key)
  if (existingLookup) return existingLookup

  // Store the handled promise, not the raw provider request. Every concurrent
  // waiter must receive the same fail-closed result when discovery rejects.
  const lookup = (async () => {
    try {
      const value = await resolveWithTimeout(driver, credentials, modelId)
      cache.set(key, { expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS, value })
      if (cache.size > MAX_CACHE_ENTRIES_PER_DRIVER) {
        const oldestKey = cache.keys().next().value
        if (oldestKey !== undefined) cache.delete(oldestKey)
      }
      return value
    } catch (err) {
      console.error(`[ai/${driver.id}] model capability lookup failed:`, err)
      // A provider-specific lookup exists because its static vision flag is not
      // authoritative. Network/schema failures therefore fail closed for image
      // input while retaining the driver's safe defaults for other features.
      return { ...fallback, visionInput: false }
    } finally {
      lookups.delete(key)
    }
  })()
  lookups.set(key, lookup)
  return lookup
}

function mapFor<T>(
  root: WeakMap<AiProvider, Map<string, T>>,
  driver: AiProvider,
): Map<string, T> {
  const existing = root.get(driver)
  if (existing) return existing
  const created = new Map<string, T>()
  root.set(driver, created)
  return created
}

function credentialRevisionKey(credentials: AiResolvedCredential): string {
  // Credentials are edited in place. Include backend/auth material so a base
  // URL or key rotation cannot reuse a positive result from the old backend;
  // hash the secret rather than retaining it in a Map key.
  return [
    credentials.id,
    credentials.authMode,
    credentials.baseUrl ?? '',
    stableHash(credentials.apiKey ?? ''),
  ].join('\0')
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

async function resolveWithTimeout(
  driver: AiProvider,
  credentials: AiResolvedCredential,
  modelId: string,
): Promise<AiProviderCapabilities> {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject(new Error(`Model capability lookup timed out after ${CAPABILITY_LOOKUP_TIMEOUT_MS}ms.`))
    }, CAPABILITY_LOOKUP_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      driver.resolveCapabilities!(credentials, modelId, controller.signal),
      timeout,
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
