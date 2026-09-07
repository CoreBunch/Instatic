import { LocalizedRouteError } from './paths'

/** Canonical hosts are configured site data, never an untrusted request Host. */
export function normalizePublicOrigin(publicOrigin: string): string {
  let url: URL
  try {
    url = new URL(publicOrigin)
  } catch {
    throw new LocalizedRouteError('settings.publicOrigin', 'The public origin must be an absolute HTTP or HTTPS origin.')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== ''
  ) {
    throw new LocalizedRouteError('settings.publicOrigin', 'The public origin cannot contain credentials, a path, a query or a fragment.')
  }
  return url.origin
}
