/**
 * Typed Directus-reader failures. Handlers map `status` onto the HTTP
 * envelope; MCP tools return `{ ok: false, error }`.
 */
export class DirectusError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DirectusError'
    this.status = status
  }
}

export function directusNotConfigured(): DirectusError {
  return new DirectusError(503, 'Directus is not configured')
}

export function directusBadRequest(message: string): DirectusError {
  return new DirectusError(400, message)
}

export function directusNotFound(message: string): DirectusError {
  return new DirectusError(404, message)
}

export function directusBadGateway(message = 'Directus upstream error'): DirectusError {
  return new DirectusError(502, message)
}
