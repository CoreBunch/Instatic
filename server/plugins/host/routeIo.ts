/**
 * Plugin route HTTP I/O — converts the inbound `Request` into the wire shape
 * the worker forwards into the VM, and converts the VM's serialized response
 * back into a real `Response`.
 *
 * Byte safety is the whole point of this module: the request body is read
 * ONCE as raw bytes, the pre-parsed conveniences (JSON / form fields /
 * multipart) are derived from those exact bytes, and binary payloads cross
 * the worker boundary base64-encoded (see `protocol/bodyEncoding.ts`).
 * Split out of `rpc.ts` so the worker round-trip plumbing and the HTTP
 * (de)serialization rules stay independently readable and testable.
 */

import {
  bytesToBase64,
  decodeBodyBytes,
  encodeBodyBytes,
} from '../protocol/bodyEncoding'
import type {
  SerializedRequest,
  SerializedResponse,
  SerializedUploadedFile,
} from '../protocol/messages'

/**
 * Serialize an inbound HTTP request for the worker. Reads the body once as
 * bytes, then pre-parses it for the handler context. Content-Type drives the
 * parser: JSON for `application/json`, URLSearchParams for
 * `application/x-www-form-urlencoded` (standard HTML form POSTs), and
 * multipart for `multipart/form-data` — text fields become strings, file
 * fields become `SerializedUploadedFile` markers carrying the exact bytes
 * (base64), which the VM bootstrap materializes into file facades. Anything
 * else leaves `body` empty; the handler reads the raw payload via
 * `ctx.req.text()` / `ctx.req.arrayBuffer()`.
 *
 * Form-encoded support is essential — any plugin that exposes a public POST
 * endpoint consumed by an HTML `<form>` (Forms Builder, Newsletter
 * subscribe, etc.) submits with this Content-Type by default. Without
 * parsing it, every such plugin returns 400 because the expected fields are
 * missing.
 */
export async function serializeRouteRequest(
  request: Request,
): Promise<{ request: SerializedRequest; body: Record<string, unknown> }> {
  // Real Bun `Headers` supports both `forEach` and the entries iterator.
  // Test stubs may only provide `.get(name)` — handle both shapes so we
  // can ship realistic typing without forcing tests to mock the full
  // Headers contract.
  const headers: Record<string, string> = {}
  const reqHeaders = request.headers as unknown as
    | { forEach?: (cb: (value: string, key: string) => void) => void; entries?: () => Iterable<[string, string]> }
    | null
  if (reqHeaders && typeof reqHeaders.forEach === 'function') {
    reqHeaders.forEach((v: string, k: string) => { headers[k.toLowerCase()] = v })
  } else if (reqHeaders && typeof reqHeaders.entries === 'function') {
    for (const [k, v] of reqHeaders.entries()) headers[k.toLowerCase()] = v
  }

  const bodyBytes = request.method !== 'GET'
    ? new Uint8Array(await request.arrayBuffer())
    : new Uint8Array(0)

  const parsedBody: Record<string, unknown> = {}
  if (bodyBytes.length > 0) {
    // Sniff on the lowercased media type, but keep the ORIGINAL header value
    // for the multipart replay below — the boundary parameter is
    // case-sensitive and lowercasing it breaks the parse.
    const rawContentType = headers['content-type'] ?? ''
    const contentType = rawContentType.toLowerCase()
    if (contentType.startsWith('application/json')) {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bodyBytes))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(parsedBody, parsed)
        }
      } catch {
        // malformed JSON — handler can inspect the raw body
      }
    } else if (contentType.startsWith('application/x-www-form-urlencoded')) {
      // URLSearchParams collapses repeated keys to the last value; for
      // forms with `name="tags"` repeated (multi-select / checkbox-group)
      // we promote those to arrays. Single-value fields stay as strings.
      const params = new URLSearchParams(new TextDecoder().decode(bodyBytes))
      for (const [key, values] of groupFields(params)) {
        parsedBody[key] = values.length === 1 ? values[0]! : values
      }
    } else if (contentType.startsWith('multipart/form-data')) {
      // Bun's `Request.formData()` parses multipart. We re-create a Request
      // from the ORIGINAL bytes + content-type (the boundary parameter rides
      // along in the header) so file payloads stay byte-exact. Text fields
      // become strings; file fields become SerializedUploadedFile markers.
      try {
        const replayReq = new Request('http://plugin-route.invalid/', {
          method: 'POST',
          headers: { 'content-type': rawContentType },
          body: bodyBytes,
        })
        const form = await replayReq.formData()
        const grouped = new Map<string, unknown[]>()
        for (const [key, value] of form.entries()) {
          const serialized = typeof value === 'string' ? value : await serializeUploadedFile(value)
          const list = grouped.get(key)
          if (list) list.push(serialized)
          else grouped.set(key, [serialized])
        }
        for (const [key, values] of grouped) {
          parsedBody[key] = values.length === 1 ? values[0]! : values
        }
      } catch {
        // malformed multipart — handler can inspect the raw body
      }
    }
  }

  return {
    request: {
      url: request.url,
      method: request.method,
      headers,
      ...encodeBodyBytes(bodyBytes),
    },
    body: parsedBody,
  }
}

function groupFields(params: URLSearchParams): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const [key, value] of params) {
    const list = grouped.get(key)
    if (list) list.push(value)
    else grouped.set(key, [value])
  }
  return grouped
}

async function serializeUploadedFile(file: File): Promise<SerializedUploadedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    __file: true,
    name: file.name,
    type: file.type,
    size: bytes.byteLength,
    dataBase64: bytesToBase64(bytes),
  }
}

/** Turn the worker's serialized route result back into a real `Response`. */
export function materializeRouteResponse(response: SerializedResponse): Response {
  if (response.kind === 'response') {
    const body = response.bodyEncoding === 'base64'
      ? decodeBodyBytes(response.body, 'base64')
      : response.body
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    })
  }
  return Response.json(response.value)
}
