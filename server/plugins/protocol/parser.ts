/**
 * Api-call parser — validates and decodes a raw worker message into a typed
 * `ValidatedApiCall`. The host calls `parseApiCall(msg)` on every inbound
 * `api-call` message before dispatch; the result is fully typed and semantics-
 * checked.
 */

import type { TSchema } from '@sinclair/typebox'
import {
  compiled,
  compiledCheck,
  compiledDecode,
} from '@core/utils/typeboxCompiler'
import {
  ApiCallSchemas,
  isAllowedApiTarget,
  type ValidatedApiCall,
} from './apiCallSchema'

export class ApiCallValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiCallValidationError'
  }
}

function firstSchemaError(schema: TSchema, value: unknown): string {
  const [error] = [...compiled(schema).Errors(value)]
  if (!error) return 'unknown validation error'
  const path = error.path || '/'
  return `${path}: ${error.message}`
}

export function normalizeRoutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

function validateApiCallSemantics(call: ValidatedApiCall): void {
  if (call.target !== 'cms.routes.register') return

  const [route] = call.args
  const normalizedPath = normalizeRoutePath(route.path)
  if (route.path !== normalizedPath) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for cms.routes.register: path must be normalized as "${normalizedPath}"`,
    )
  }

  const expectedRouteKey = `${route.method}:${normalizedPath}`
  if (route.routeKey !== expectedRouteKey) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for cms.routes.register: routeKey must be "${expectedRouteKey}"`,
    )
  }
}

export function parseApiCall(value: unknown): ValidatedApiCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiCallValidationError('Invalid api-call payload: expected object')
  }

  const target = (value as { target?: unknown }).target
  if (typeof target !== 'string' || !isAllowedApiTarget(target)) {
    throw new ApiCallValidationError('Invalid api-call payload: unknown target')
  }

  const schema = ApiCallSchemas[target]
  if (!compiledCheck(schema, value)) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for ${target}: ${firstSchemaError(schema, value)}`,
    )
  }

  const parsed = compiledDecode(schema, value)
  validateApiCallSemantics(parsed)
  return parsed
}

// Re-export so callers can import the full allowlist if needed.

