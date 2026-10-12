/**
 * Property-control factories — short, named helpers that produce
 * `PluginPropertyControl` records with one line each.
 *
 *   schema: {
 *     title: control.text('Title', { placeholder: 'Hero headline' }),
 *     body:  control.textarea('Body', { rows: 4 }),
 *     tone:  control.select('Tone', [
 *       { label: 'Info',    value: 'info' },
 *       { label: 'Warning', value: 'warning' },
 *     ]),
 *   }
 *
 * The label always comes first because plugin authors think label-first; the
 * options bag is optional and per-control-type-specific.
 */
import type { PluginPropertyControl } from '../modules'

type SelectOption<T> = { label: string; value: T; iconSvg?: string }

export const control = {
  text(label: string, options: { placeholder?: string; description?: string } = {}): PluginPropertyControl {
    return { type: 'text', label, ...options }
  },

  textarea(
    label: string,
    options: { placeholder?: string; rows?: number; description?: string } = {},
  ): PluginPropertyControl {
    return { type: 'textarea', label, ...options }
  },

  number(
    label: string,
    options: { min?: number; max?: number; step?: number; unit?: string; presets?: number[]; description?: string } = {},
  ): PluginPropertyControl {
    return { type: 'number', label, ...options }
  },

  color(
    label: string,
    options: { format?: 'hex' | 'rgba'; description?: string } = {},
  ): PluginPropertyControl {
    return { type: 'color', label, ...options }
  },

  select<T>(
    label: string,
    optionsOrOptionsList: SelectOption<T>[] | { options: SelectOption<T>[]; description?: string },
  ): PluginPropertyControl {
    const list = Array.isArray(optionsOrOptionsList)
      ? optionsOrOptionsList
      : optionsOrOptionsList.options
    const description = Array.isArray(optionsOrOptionsList) ? undefined : optionsOrOptionsList.description
    return { type: 'select', label, options: list, ...(description ? { description } : {}) }
  },

  toggle(label: string, options: { description?: string } = {}): PluginPropertyControl {
    return { type: 'toggle', label, ...options }
  },

  image(label: string, options: { description?: string } = {}): PluginPropertyControl {
    return { type: 'image', label, ...options }
  },

  url(label: string, options: { description?: string } = {}): PluginPropertyControl {
    return { type: 'url', label, ...options }
  },
}
