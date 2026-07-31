import { type TSchema, type Static } from '@sinclair/typebox'
import { safeParseValue } from '@core/utils/typeboxHelpers'

interface ReadValidatedBodyOptions {
  maxBytes?: number
  /**
   * Allows a standard browser form POST to carry a JSON payload in one field.
   * Used for native attachment downloads where `fetch().blob()` would force the
   * browser to materialize the whole response in JS memory/blob storage.
   */
  formJsonField?: string
}

export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`)
    this.name = 'RequestBodyTooLargeError'
    this.maxBytes = maxBytes
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const res = new Response(JSON.stringify(body), init)
  res.headers.set('content-type', 'application/json')
  return res
}

export function methodNotAllowed(): Response {
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

export function badRequest(message: string): Response {
  return jsonResponse({ error: message }, { status: 400 })
}

export function payloadTooLarge(message: string): Response {
  return jsonResponse({ error: message }, { status: 413 })
}

/**
 * Parse and validate a request body against a TypeBox schema. Returns the
 * validated value on success, or null on JSON parse failure or schema mismatch.
 * Callers return `badRequest(msg)` on null.
 */
export async function readValidatedBody<T extends TSchema>(
  req: Request,
  schema: T,
  options: ReadValidatedBodyOptions = {},
): Promise<Static<T> | null> {
  let raw: unknown
  try {
    const formJsonField = options.formJsonField
    if (shouldReadFormJsonField(req, formJsonField) && formJsonField) {
      raw = await readFormJsonField(req, formJsonField)
    } else if (options.maxBytes === undefined) {
      raw = await req.json()
    } else {
      raw = await readJsonWithLimit(req, options.maxBytes)
    }
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) throw err
    return null
  }
  const parsed = safeParseValue(schema, raw)
  return parsed.ok ? (parsed.value as Static<T>) : null
}

function shouldReadFormJsonField(req: Request, fieldName: string | undefined): boolean {
  if (!fieldName) return false
  const contentType = req.headers.get('content-type')?.toLowerCase() ?? ''
  return (
    contentType.startsWith('application/x-www-form-urlencoded') ||
    contentType.startsWith('multipart/form-data')
  )
}

async function readFormJsonField(req: Request, fieldName: string): Promise<unknown> {
  const form = await req.formData()
  const value = form.get(fieldName)
  if (typeof value !== 'string') return null
  return JSON.parse(value)
}

async function readJsonWithLimit(req: Request, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readTextBodyWithLimit(req, maxBytes))
}

/** Read a UTF-8 request body with a hard streaming byte limit. */
export async function readTextBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  if (maxBytes < 1) throw new Error('readTextBodyWithLimit: maxBytes must be >= 1')
  const contentLength = req.headers.get('content-length')
  if (contentLength) {
    const parsed = Number(contentLength)
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes)
    }
  }

  const reader = req.body?.getReader()
  if (!reader) return ''

  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new RequestBodyTooLargeError(maxBytes)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(bytes)
}

export function setCookieHeader(res: Response, value: string): Response {
  res.headers.append('set-cookie', value)
  return res
}
