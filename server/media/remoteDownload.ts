/** Shared, bounded downloader for host-mediated remote media imports. */
import { guardedFetch, type GuardedFetchOptions } from '../plugins/host/network'

const FETCH_TIMEOUT_MS = 15_000

export interface RemoteMediaDownloadOptions {
  allowlist?: ReadonlyArray<string>
  signal?: AbortSignal
  maxBytes: number
  label?: string
}

export type RemoteMediaDownloadDeps = Pick<GuardedFetchOptions, 'fetchImpl' | 'resolveHost'>

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || !response.body) {
    throw new Error(`Remote media download failed (HTTP ${response.status}).`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    signal.throwIfAborted()
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`Remote media exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`)
    }
    chunks.push(value)
  }
  if (total === 0) throw new Error('Remote media download was empty.')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function downloadRemoteMedia(
  sourceUrl: string,
  options: RemoteMediaDownloadOptions,
  deps: RemoteMediaDownloadDeps = {},
): Promise<Uint8Array<ArrayBuffer>> {
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    throw new Error(`Remote media sourceUrl is invalid: "${sourceUrl}".`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Remote media sourceUrl must use HTTPS (got "${url.protocol}").`)
  }
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal
  const response = await guardedFetch(url.toString(), { method: 'GET' }, {
    allowlist: options.allowlist,
    label: options.label ?? 'Remote media',
    requireHttps: true,
    signal,
    ...deps,
  })
  return readBoundedBody(response, options.maxBytes, signal)
}
