import { registry, resolvePropertyControlCategory, type PropertySchema } from '@core/module-engine'
import { Type } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import type { VisualComponent } from './schemas'

const ParameterValuesSchema = Type.Record(Type.String(), Type.Unknown())
const CONTENT_PARAMETER_TYPES = new Set(['string', 'url', 'image', 'richText'])

function contentProperty(schema: PropertySchema, key: string): boolean {
  for (const [name, control] of Object.entries(schema)) {
    if (control.type === 'group') {
      if (contentProperty(control.children, key)) return true
    } else if (name === key) return !control.hidden && resolvePropertyControlCategory(control) === 'content'
  }
  return false
}

/** Definitions and design parameters stay shared; content defaults may be translated. */
export function localizableComponentParameterIds(component: VisualComponent): ReadonlySet<string> {
  const ids = new Set(component.params.filter((parameter) =>
    CONTENT_PARAMETER_TYPES.has(parameter.type) && parameter.localization !== 'shared',
  ).map((parameter) => parameter.id))
  for (const node of Object.values(component.tree.nodes)) {
    for (const [property, binding] of Object.entries(node.propBindings ?? {})) {
      const module = registry.get(node.moduleId)
      if (!module || !contentProperty(module.schema, property)) ids.delete(binding.paramId)
    }
  }
  return ids
}

export function readComponentParameterValues(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!compiledCheck(ParameterValuesSchema, value)) throw new Error('Invalid component parameter defaults')
  return value
}

export function projectComponentParameterDefaults(component: VisualComponent, value: unknown): VisualComponent {
  const values = readComponentParameterValues(value)
  const allowed = localizableComponentParameterIds(component)
  return { ...component, params: component.params.map((parameter) =>
    allowed.has(parameter.id) && Object.hasOwn(values, parameter.id)
      ? { ...parameter, defaultValue: values[parameter.id] } : parameter,
  ) }
}
