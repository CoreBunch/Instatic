import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Link a fetch-based Vite proxy request to its downstream browser response.
 * Vite runs under Bun in this repository, so the native fetch path avoids the
 * Node `http.request` compatibility sockets that otherwise accumulate across
 * repeated browser contexts. Aborting also cancels long-lived SSE/NDJSON
 * response bodies as soon as their browser consumer disappears.
 */
export function linkProxyFetchToDownstream(
  requestOptions: RequestInit,
  _req: IncomingMessage,
  downstreamResponse: ServerResponse,
): void {
  const downstreamAbort = new AbortController()
  const abortUpstream = () => {
    if (!downstreamResponse.writableFinished) downstreamAbort.abort()
  }

  downstreamResponse.once('close', abortUpstream)
  requestOptions.signal = requestOptions.signal
    ? AbortSignal.any([requestOptions.signal, downstreamAbort.signal])
    : downstreamAbort.signal
}
