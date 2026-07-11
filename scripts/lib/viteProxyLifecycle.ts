import type { HttpProxy } from 'vite'

/**
 * Close an active upstream response when its downstream browser connection
 * disappears. http-proxy-3 destroys the ClientRequest on downstream close,
 * but after response headers arrive that request is already complete and its
 * response socket stays open. Long-lived SSE/NDJSON responses would otherwise
 * accumulate across browser reloads until the development proxy stalls.
 */
export function configureProxyResponseLifecycle(proxy: HttpProxy.ProxyServer): void {
  proxy.on('proxyRes', (proxyResponse, _req, downstreamResponse) => {
    const destroyUpstream = () => {
      if (!downstreamResponse.writableFinished) proxyResponse.destroy()
    }
    const detachDownstream = () => {
      downstreamResponse.off('close', destroyUpstream)
    }

    downstreamResponse.once('close', destroyUpstream)
    proxyResponse.once('end', detachDownstream)
    proxyResponse.once('close', detachDownstream)
  })
}
