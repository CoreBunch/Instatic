import { publicOriginIsHttps } from './auth/security'

/**
 * Apply security response headers to every outbound response.
 *
 * This is the single point that stamps security headers onto the Response
 * the Bun.serve fetch handler returns. Placing the gate here (rather than
 * inside handleServerRequest) ensures OPTIONS preflight and unhandled-crash
 * error responses also carry the headers.
 *
 * Global headers (applied to every response):
 *   - `X-Content-Type-Options: nosniff` — prevents MIME-sniffing. Already set
 *     by hardenUploadResponse for /uploads/*; identical value here is a no-op
 *     on those responses.
 *   - `Referrer-Policy: strict-origin-when-cross-origin` — limits Referer
 *     leakage on cross-origin navigations without breaking same-origin
 *     analytics. Not applied when the route already sets a stricter value
 *     (e.g. the media signed-redirect uses `no-referrer`).
 *   - `Strict-Transport-Security: max-age=63072000; includeSubDomains` — only
 *     when the configured public origin is HTTPS. Adding HSTS on an HTTP-only
 *     install (local dev, intentional HTTP) would brick the site.
 *
 * Admin-specific headers (pathname starts with /admin):
 *   - `X-Frame-Options: DENY` — blocks framing in legacy browsers.
 *   - `Content-Security-Policy` — three directives that are safe today:
 *       · `frame-ancestors 'none'` — blocks framing in modern browsers (sent
 *         alongside X-Frame-Options, which it supersedes where supported).
 *       · `base-uri 'self'` — blocks a `<base href>` injection from rewriting
 *         the resolution of every relative URL on the page (the admin never
 *         emits a `<base>` element).
 *       · `object-src 'none'` — blocks `<object>` / `<embed>` plugin content
 *         (the admin never embeds either).
 *
 *   A `script-src` / `style-src` policy is deliberately NOT set here yet: the
 *   admin ships an inline `<script type="importmap">` the plugin runtime needs,
 *   the visual-editor canvas is `srcDoc` iframes (which inherit this policy)
 *   that inject the site's runtime scripts as inline `<script>`, and the
 *   editor relies on inline styles for dynamic custom properties. A safe
 *   `script-src` therefore requires per-request nonce plumbing through the
 *   served-HTML patcher and the canvas script injector plus a full editor
 *   browser sweep — tracked as a dedicated follow-up, not bolted on here.
 *
 * @param res      The raw Response from the route handler.
 * @param pathname URL pathname of the incoming request.
 */
export function applySecurityHeaders(res: Response, pathname: string): Response {
  const headers = new Headers(res.headers)

  // ── Global headers — every response ─────────────────────────────────────

  headers.set('x-content-type-options', 'nosniff')

  // Preserve stricter per-route Referrer-Policy values (e.g. the signed-media
  // redirect uses `no-referrer` to prevent leaking the signed URL to the
  // redirect target).
  if (!headers.has('referrer-policy')) {
    headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  }

  if (publicOriginIsHttps()) {
    headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains')
  }

  // ── Admin-specific — prevent clickjacking ────────────────────────────────
  // Both the admin HTML shell and admin API responses must not be frameable.
  // A framed CMS admin is a clickjacking vector for one-click publish/delete.
  if (pathname.startsWith('/admin')) {
    headers.set('x-frame-options', 'DENY')
    headers.set(
      'content-security-policy',
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    )
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}
