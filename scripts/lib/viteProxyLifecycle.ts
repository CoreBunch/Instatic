import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Link a fetch-based Vite proxy request to its downstream browser response.
 * Vite runs under Bun in this repository, so the native fetch path avoids the
 * Node `http.request` compatibility sockets that otherwise accumulate across
 * repeated browser contexts. Aborting also cancels long-lived SSE/NDJSON
 * response bodies as soon as their browser consumer disappears.
 */
export function prepareProxyFetch(
  requestOptions: RequestInit,
  _req: IncomingMessage,
  downstreamResponse: ServerResponse,
): void {
  const downstreamAbort = new AbortController()
  const headers = new Headers(requestOptions.headers)
  // http-proxy-3 prepares fetch requests through its Node HTTP option builder,
  // which injects `Connection: close` when no Node Agent is configured. Native
  // fetch owns pooling itself; remove that hop-by-hop header so Bun can reuse
  // the CMS connection instead of leaving one established socket per request.
  headers.delete('connection')
  requestOptions.headers = headers

  const abortUpstream = () => {
    downstreamAbort.abort()
  }

  downstreamResponse.once('close', abortUpstream)
  requestOptions.signal = requestOptions.signal
    ? AbortSignal.any([requestOptions.signal, downstreamAbort.signal])
    : downstreamAbort.signal
}

async function waitForDrainOrClose(response: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      response.off('drain', done)
      response.off('close', done)
      resolve()
    }
    response.once('drain', done)
    response.once('close', done)
  })
}

/** Stream a native fetch response and cancel its active reader on disconnect. */
export async function forwardProxyFetchResponse(
  upstreamResponse: Response,
  req: IncomingMessage,
  downstreamResponse: ServerResponse,
): Promise<void> {
  if (downstreamResponse.destroyed) {
    await upstreamResponse.body?.cancel()
    return
  }

  const headers: Record<string, string> = {}
  upstreamResponse.headers.forEach((value, key) => {
    headers[key] = value
  })
  downstreamResponse.writeHead(upstreamResponse.status, headers)

  if (req.method === 'HEAD' || !upstreamResponse.body) {
    downstreamResponse.end()
    return
  }

  const reader = upstreamResponse.body.getReader()
  let downstreamClosed = false
  const cancelUpstream = () => {
    downstreamClosed = true
    void reader.cancel().catch(() => {})
  }
  downstreamResponse.once('close', cancelUpstream)

  try {
    while (!downstreamClosed) {
      const { done, value } = await reader.read()
      if (done) break
      if (!downstreamResponse.write(value)) {
        await waitForDrainOrClose(downstreamResponse)
      }
    }
    if (!downstreamClosed && !downstreamResponse.writableEnded) {
      downstreamResponse.end()
    }
  } catch (err) {
    if (!downstreamClosed) throw err
  } finally {
    downstreamResponse.off('close', cancelUpstream)
    reader.releaseLock()
  }
}
