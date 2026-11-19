/**
 * Plugin resource-record helpers.
 *
 * Split out of `manifest.ts` (which owns manifest parsing + validation):
 * looking up a declared resource and validating record payloads against its
 * field schema is the record-CRUD responsibility, consumed by the plugin
 * record handlers and the editor-side storage SDK. Re-exported through
 * `@core/plugins/manifest`, which stays the public surface.
 */
import { STORAGE_UNIQUE_KEY_MAX_LENGTH, type PluginManifest, type PluginResource } from '@core/plugin-sdk'

export function findPluginResource(
  manifest: Pick<PluginManifest, 'resources'>,
  resourceId: string,
): PluginResource | null {
  return manifest.resources.find((resource) => resource.id === resourceId) ?? null
}

export function validatePluginRecordData(
  resource: PluginResource,
  input: unknown,
  options: { partial?: boolean } = {},
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Plugin record data must be an object')
  }

  const raw = input as Record<string, unknown>
  const data: Record<string, unknown> = {}

  for (const field of resource.fields) {
    const value = raw[field.id]
    const missing = value === undefined || value === null || value === ''

    if (missing) {
      if (field.required && !options.partial) {
        throw new Error(`Missing required field "${field.label}"`)
      }
      continue
    }

    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Field "${field.label}" must be a number`)
      }
      data[field.id] = value
      continue
    }

    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`Field "${field.label}" must be a boolean`)
      }
      data[field.id] = value
      continue
    }

    if (typeof value !== 'string') {
      throw new Error(`Field "${field.label}" must be text`)
    }
    data[field.id] = value.trim()
  }

  return data
}

/**
 * The unique key a record takes from its resource's `uniqueField`: the
 * validated (trimmed) text value as it is, or null when the resource declares
 * no `uniqueField` or the record leaves the field empty. Records with a null
 * key never collide with each other.
 *
 * Call with data that already went through `validatePluginRecordData`.
 */
export function pluginRecordUniqueKey(
  resource: PluginResource | null,
  data: Record<string, unknown>,
): string | null {
  if (!resource?.uniqueField) return null
  const value = data[resource.uniqueField]
  if (typeof value !== 'string' || value === '') return null
  if (value.length > STORAGE_UNIQUE_KEY_MAX_LENGTH) {
    throw new Error(
      `Field "${resource.uniqueField}" is the unique key of "${resource.id}" and may hold at most ` +
        `${STORAGE_UNIQUE_KEY_MAX_LENGTH} characters`,
    )
  }
  return value
}
