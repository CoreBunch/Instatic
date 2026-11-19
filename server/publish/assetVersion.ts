/**
 * Content-versioned script assets: the version stamped into a script URL and
 * the caching rule its route answers with.
 *
 * `assetContentVersion` is a short SHA-256 of a script body. It is stamped as
 * `?v=` on the tags that reference `/_instatic/module-js/<id>.js`,
 * `/_instatic/hole-runtime.js` and `/_instatic/assets/loop-runtime.js`, so the
 * URL changes exactly when the body does. It is derived from the body alone:
 * it survives a restart (unlike the process-local `publishVersion`) and
 * changes on a CMS upgrade that ships a new script (unlike the site snapshot
 * hash).
 *
 * `serveVersionedScript` is the one response rule those three routes share.
 */
import { createHash } from 'node:crypto'

export function assetContentVersion(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12)
}

/** True when an `If-None-Match` header names `etag` (weak comparison, `*` included). */
function ifNoneMatchNames(header: string | null, etag: string): boolean {
  if (!header) return false
  return header.split(',').some((candidate) => {
    const tag = candidate.trim()
    return tag === '*' || (tag.startsWith('W/') ? tag.slice(2) : tag) === etag
  })
}

/**
 * Answer a GET for a script whose URL may carry its content version.
 *
 * - `?v=` equal to `version`: the URL names this body, so it is cacheable for
 *   an hour (`public, max-age=3600`).
 * - Any other URL (a page baked before the script changed, or no `?v=`):
 *   `no-cache`, so a stale URL never pins a body it does not name.
 *
 * Every response carries `ETag: "<version>"`, and a request whose
 * `If-None-Match` names it gets `304 Not Modified` with no body. That is what
 * keeps a stale URL cheap: it revalidates on each view instead of
 * re-downloading the script.
 */
export function serveVersionedScript(
  req: Request,
  url: URL,
  script: { body: string; version: string },
): Response {
  const etag = `"${script.version}"`
  const headers = {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': url.searchParams.get('v') === script.version ? 'public, max-age=3600' : 'no-cache',
    etag,
  }
  if (ifNoneMatchNames(req.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(script.body, { headers })
}
