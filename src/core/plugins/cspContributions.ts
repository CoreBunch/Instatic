import type {
  PluginCspContribution,
  PluginCspDirective,
  PluginPermission,
  PluginPublisherDeclarations,
  PluginResource,
} from '@core/plugin-sdk'
import { PLUGIN_CSP_DIRECTIVE_VALUES } from '@core/plugin-sdk'

const allowedDirectives = new Set<string>(PLUGIN_CSP_DIRECTIVE_VALUES)
const expectedFields = new Map<string, { type: string; required: boolean }>([
  ['directive', { type: 'text', required: true }],
  ['origin', { type: 'text', required: true }],
  ['enabled', { type: 'boolean', required: true }],
  ['description', { type: 'longtext', required: false }],
])

export function assertPluginCspResource(resource: PluginResource): void {
  const fields = new Map(resource.fields.map((field) => [field.id, field]))
  for (const [id, expected] of expectedFields) {
    const field = fields.get(id)
    if (!field || field.type !== expected.type || Boolean(field.required) !== expected.required) {
      throw new Error(
        `Invalid plugin manifest: publisher CSP resource field "${id}" must be ` +
        `${expected.required ? 'required ' : ''}${expected.type}`,
      )
    }
  }
  for (const id of fields.keys()) {
    if (!expectedFields.has(id)) {
      throw new Error(`Invalid plugin manifest: publisher CSP resource has unsupported field "${id}"`)
    }
  }
}

export function assertPluginCspPublisherDeclaration(
  publisher: PluginPublisherDeclarations | undefined,
  permissions: PluginPermission[],
  resources: PluginResource[],
): void {
  if (!publisher) return
  if (!permissions.includes('publisher.csp')) {
    throw new Error('Invalid plugin manifest: `publisher.csp` requires the `publisher.csp` permission.')
  }
  const resource = resources.find((candidate) => candidate.id === publisher.csp.resource)
  if (!resource) {
    throw new Error(
      `Invalid plugin manifest: publisher CSP references unknown resource "${publisher.csp.resource}"`,
    )
  }
  assertPluginCspResource(resource)
}

function canonicalHttpsOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error('CSP origin must be an exact canonical HTTPS origin')
  }
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new Error('CSP origin must contain only canonical ASCII URL characters')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('CSP origin is malformed')
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.hostname.includes('*') ||
    url.username ||
    url.password ||
    value !== url.origin
  ) {
    throw new Error('CSP origin must be an exact canonical HTTPS origin without credentials, path, query, or fragment')
  }
  return url.origin
}

export function validatePluginCspContributionRecord(input: unknown): PluginCspContribution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('CSP contribution must be an object')
  }
  const raw = input as Record<string, unknown>
  const keys = Object.keys(raw)
  for (const key of keys) {
    if (!expectedFields.has(key)) throw new Error(`Unsupported CSP contribution field "${key}"`)
  }
  if (typeof raw.directive !== 'string' || !allowedDirectives.has(raw.directive)) {
    throw new Error(`CSP directive must be one of: ${PLUGIN_CSP_DIRECTIVE_VALUES.join(', ')}`)
  }
  if (typeof raw.enabled !== 'boolean') throw new Error('CSP contribution enabled must be boolean')
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new Error('CSP contribution description must be text')
  }
  const description = raw.description?.trim()
  if (description && description.length > 500) {
    throw new Error('CSP contribution description must be 500 characters or fewer')
  }
  return {
    directive: raw.directive as PluginCspDirective,
    origin: canonicalHttpsOrigin(raw.origin),
    enabled: raw.enabled,
    ...(description ? { description } : {}),
  }
}
