/**
 * Plugin settings — declarative configuration that the host renders as a
 * form using the curated `pluginAdminUi` primitives.
 *
 *   settings: [
 *     { id: 'apiKey',           type: 'text',     label: 'API key',     secret: true },
 *     { id: 'trackOutbound',    type: 'toggle',   label: 'Track clicks', default: true },
 *     { id: 'theme',            type: 'select',   label: 'Theme',
 *       options: [
 *         { label: 'Light', value: 'light' },
 *         { label: 'Dark',  value: 'dark'  },
 *       ],
 *       default: 'light',
 *     },
 *   ]
 *
 * Plugins read settings at runtime via `api.cms.settings.get(key)` (server)
 * and via the admin-app context hook. Frontend bundles read non-secret
 * values by fetching them through the plugin's own public route — the
 * host never exposes plugin settings to the published page directly.
 * The host stores settings per-plugin in the `installed_plugins.settings_json`
 * column.
 *
 * Why a separate concept from canvas-module schema: settings are
 * site-owner-managed, persist across plugin updates, and may carry secrets
 * that must never reach the published page or the canvas. Module schema
 * defines per-instance content typed into a node by the editor.
 */

export type PluginSettingValue = string | number | boolean

interface PluginSettingBase {
  /** Stable identifier — `[a-zA-Z_][a-zA-Z0-9_-]*`. */
  id: string
  /** Human label for the form field. */
  label: string
  /** Optional help text displayed under the field. */
  description?: string
  /** Whether the field must be filled before save. */
  required?: boolean
  /**
   * When true, the value is treated as a secret:
   *   - Masked (`'***'`) on EVERY payload the host sends to the browser —
   *     the plugins list, the settings GET/PUT responses, admin-page route
   *     snapshots, and editor-panel settings snapshots
   *   - Stripped from frontend bundles
   *   - Rendered as a password input in the form
   * Only server-side plugin code (`api.cms.settings.get` / `getAll` inside
   * the QuickJS worker) reads the real value. Editor-side and admin-app
   * plugin code always sees the mask.
   */
  secret?: boolean
}

export type PluginSettingDefinition =
  | (PluginSettingBase & {
      type: 'text'
      placeholder?: string
      default?: string
    })
  | (PluginSettingBase & {
      type: 'textarea'
      placeholder?: string
      rows?: number
      default?: string
    })
  | (PluginSettingBase & {
      type: 'number'
      min?: number
      max?: number
      step?: number
      unit?: string
      default?: number
    })
  | (PluginSettingBase & {
      type: 'toggle'
      default?: boolean
    })
  | (PluginSettingBase & {
      type: 'select'
      options: ReadonlyArray<{ label: string; value: string }>
      default?: string
    })
  | (PluginSettingBase & {
      type: 'color'
      format?: 'hex' | 'rgba'
      default?: string
    })
  | (PluginSettingBase & {
      type: 'url'
      default?: string
    })
  | (PluginSettingBase & {
      type: 'password'
      placeholder?: string
      default?: string
    })

export type PluginSettingsValues = Record<string, PluginSettingValue>

/**
 * Sentinel the host substitutes for secret values on every browser-bound
 * payload. The settings PUT route treats an incoming secret equal to this
 * sentinel as "unchanged" and keeps the stored value — see
 * `resolveSecretSettingsUpdate`. Consequence: a secret can never be
 * literally `'***'`.
 */
export const SECRET_SETTING_MASK = '***'

const SAFE_SETTING_ID = /^[a-zA-Z_][a-zA-Z0-9_-]*$/

/**
 * Validate a settings array at definePlugin time — surfaces shape errors
 * before the manifest hits the host parser.
 */
export function validatePluginSettingsDefinitions(
  pluginId: string,
  settings: PluginSettingDefinition[],
): void {
  const seen = new Set<string>()
  for (const s of settings) {
    if (!SAFE_SETTING_ID.test(s.id)) {
      throw new Error(
        `[plugin-sdk] Plugin "${pluginId}" setting id "${s.id}" is invalid. ` +
          `Use letters, digits, dashes, underscores; must start with a letter or underscore.`,
      )
    }
    if (seen.has(s.id)) {
      throw new Error(`[plugin-sdk] Plugin "${pluginId}" has duplicate setting id "${s.id}".`)
    }
    seen.add(s.id)
    if (!s.label || typeof s.label !== 'string') {
      throw new Error(`[plugin-sdk] Plugin "${pluginId}" setting "${s.id}" must have a label.`)
    }
  }
}

/**
 * Pure helper: derive an initial settings record from a settings schema.
 * Used by the host on plugin install, and by the admin form when rendering
 * a freshly-installed plugin's empty Settings panel.
 */
export function pluginSettingsDefaults(
  settings: ReadonlyArray<PluginSettingDefinition>,
): PluginSettingsValues {
  const out: PluginSettingsValues = {}
  for (const s of settings) {
    if (s.default !== undefined) out[s.id] = s.default
    else if (s.type === 'toggle') out[s.id] = false
    else if (s.type === 'number') out[s.id] = 0
    else out[s.id] = ''
  }
  return out
}

/**
 * Validate a runtime settings record against a settings schema. Used by
 * the host's HTTP route before persisting changes. Returns the cleaned
 * record (extra keys dropped, missing required fields throw).
 */
export function validatePluginSettingsRecord(
  settings: ReadonlyArray<PluginSettingDefinition>,
  input: unknown,
): PluginSettingsValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Settings must be an object.')
  }
  const raw = input as Record<string, unknown>
  const out: PluginSettingsValues = {}
  for (const s of settings) {
    const value = raw[s.id]
    if (value === undefined || value === null || value === '') {
      if (s.required) {
        throw new Error(`Setting "${s.label}" is required.`)
      }
      // Use schema default when the form omits the field.
      const defaults = pluginSettingsDefaults([s])
      if (s.id in defaults) out[s.id] = defaults[s.id]
      continue
    }
    if (s.type === 'toggle') {
      if (typeof value !== 'boolean') throw new Error(`Setting "${s.label}" must be a boolean.`)
      out[s.id] = value
      continue
    }
    if (s.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Setting "${s.label}" must be a number.`)
      }
      if (typeof s.min === 'number' && value < s.min) {
        throw new Error(`Setting "${s.label}" must be at least ${s.min}.`)
      }
      if (typeof s.max === 'number' && value > s.max) {
        throw new Error(`Setting "${s.label}" must be at most ${s.max}.`)
      }
      out[s.id] = value
      continue
    }
    if (s.type === 'select') {
      const allowed = s.options.map((opt) => opt.value)
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(`Setting "${s.label}" must be one of: ${allowed.join(', ')}.`)
      }
      out[s.id] = value
      continue
    }
    // text / textarea / password / color / url
    if (typeof value !== 'string') {
      throw new Error(`Setting "${s.label}" must be a string.`)
    }
    out[s.id] = value
  }
  return out
}

/**
 * Mask secret values in a settings record before serializing it onto any
 * browser-bound payload — the plugins list, the settings GET/PUT responses,
 * admin-page route snapshots, editor-panel snapshots. Only server-side
 * plugin code reading via `api.cms.settings.get` sees the real value.
 */
export function maskSecretSettings(
  settings: ReadonlyArray<PluginSettingDefinition>,
  values: PluginSettingsValues,
): PluginSettingsValues {
  const out: PluginSettingsValues = { ...values }
  for (const s of settings) {
    if (s.secret && out[s.id] !== undefined && out[s.id] !== '') {
      out[s.id] = SECRET_SETTING_MASK
    }
  }
  return out
}

/**
 * Resolve a settings PUT against the stored record: an incoming secret equal
 * to `SECRET_SETTING_MASK` means the admin form submitted the masked GET
 * value untouched, so the stored secret is kept. Any other incoming value —
 * including the empty string, which deliberately clears the secret — wins.
 */
export function resolveSecretSettingsUpdate(
  settings: ReadonlyArray<PluginSettingDefinition>,
  incoming: PluginSettingsValues,
  stored: PluginSettingsValues,
): PluginSettingsValues {
  const out: PluginSettingsValues = { ...incoming }
  for (const s of settings) {
    if (s.secret && out[s.id] === SECRET_SETTING_MASK && stored[s.id] !== undefined) {
      out[s.id] = stored[s.id]
    }
  }
  return out
}

/**
 * Strip secret values entirely. Used when projecting settings into the
 * frontend bundle / published page where they would otherwise leak.
 */
export function stripSecretSettings(
  settings: ReadonlyArray<PluginSettingDefinition>,
  values: PluginSettingsValues,
): PluginSettingsValues {
  const out: PluginSettingsValues = {}
  for (const [key, value] of Object.entries(values)) {
    const def = settings.find((s) => s.id === key)
    if (def?.secret) continue
    out[key] = value
  }
  return out
}
