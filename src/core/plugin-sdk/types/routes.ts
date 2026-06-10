// ---------------------------------------------------------------------------
// Server-side route registration — plugin handlers behind cms.routes
// ---------------------------------------------------------------------------

export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/**
 * Simplified request object available to plugin route handlers inside the
 * QuickJS sandbox. A subset of the Web `Request` API — only the fields that
 * cross the JSON boundary from the Bun host into the VM.
 *
 * `headers` is a **case-insensitive** facade matching the standard `Headers`
 * interface surface. It normalises all key lookups to lowercase, so
 * `headers.get('Content-Type')` and `headers.get('content-type')` are
 * equivalent — matching WHATWG `Headers.get()` semantics.
 */
export interface ServerPluginRequest {
  url: string
  method: string
  headers: {
    get(name: string): string | null
    has(name: string): boolean
    entries(): Array<[string, string]>
    keys(): string[]
    values(): string[]
    forEach(cb: (value: string, name: string) => void): void
  }
  json(): Promise<unknown>
  text(): Promise<string>
  /** The raw request body bytes — byte-exact, including binary payloads. */
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * A file field from a `multipart/form-data` request body. The host parses
 * the multipart payload from the raw request bytes, so `arrayBuffer()`
 * returns the uploaded file byte-exactly — images, PDFs, and other binary
 * uploads are never corrupted.
 */
export interface ServerPluginUploadedFile {
  name: string
  type: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

export interface ServerPluginRouteContext {
  req: ServerPluginRequest
  /**
   * Pre-parsed body fields (`application/json` object members,
   * `application/x-www-form-urlencoded` fields, `multipart/form-data`
   * fields). Repeated form keys become arrays; multipart file fields are
   * `ServerPluginUploadedFile` instances.
   */
  body: Record<string, unknown>
  user: {
    id: string
    email: string
    capabilities: string[]
  } | null
}

/**
 * Handler for a plugin-registered server route.
 *
 * By default, any returned value is JSON-serialized and sent as
 * `application/json` with status 200. To control the HTTP status code,
 * response headers, or body encoding (e.g. CSV, plain text, HTML, binary),
 * return the **raw-response escape hatch**:
 *
 * ```ts
 * return {
 *   __response: true,
 *   status: 200,
 *   headers: {
 *     'Content-Type': 'text/csv; charset=utf-8',
 *     'Content-Disposition': 'attachment; filename="export.csv"',
 *   },
 *   body: csvString,  // string | ArrayBuffer | TypedArray/DataView
 * }
 * ```
 *
 * `body` accepts a string (sent as UTF-8 text) or an
 * ArrayBuffer / TypedArray / DataView (sent byte-exactly — serve images,
 * zips, PDFs directly). Any other body type throws a TypeError.
 *
 * Returning `undefined` is equivalent to returning `{ ok: true }` (status 200,
 * JSON body).
 */
export type ServerPluginRouteHandler = (
  context: ServerPluginRouteContext,
) => unknown | Promise<unknown>
