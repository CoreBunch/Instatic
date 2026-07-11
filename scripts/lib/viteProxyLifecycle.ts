import type { HttpProxy } from 'vite'

/** Destroy the active upstream response whenever its browser consumer closes. */
export function configureProxyResponseLifecycle(proxy: HttpProxy.ProxyServer): void {
  proxy.on('proxyRes', (proxyResponse, req, downstreamResponse) => {
    const detachDownstream = () => {
      downstreamResponse.off('close', destroyUpstream)
      req.socket.off('close', destroyUpstream)
    }
    const destroyUpstream = () => {
      detachDownstream()
      proxyResponse.destroy()
    }

    downstreamResponse.once('close', destroyUpstream)
    req.socket.once('close', destroyUpstream)
    proxyResponse.once('end', detachDownstream)
  })
}
