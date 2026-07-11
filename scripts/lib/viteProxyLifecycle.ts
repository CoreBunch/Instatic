import type { HttpProxy } from 'vite'

/** Destroy the active upstream response whenever its browser consumer closes. */
export function configureProxyResponseLifecycle(proxy: HttpProxy.ProxyServer): void {
  proxy.on('proxyRes', (proxyResponse, _req, downstreamResponse) => {
    const destroyUpstream = () => {
      proxyResponse.destroy()
    }
    const detachDownstream = () => {
      downstreamResponse.off('close', destroyUpstream)
    }

    downstreamResponse.once('close', destroyUpstream)
    proxyResponse.once('end', detachDownstream)
    proxyResponse.once('close', detachDownstream)
  })
}
