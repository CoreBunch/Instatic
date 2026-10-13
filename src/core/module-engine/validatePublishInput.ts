import { compiled } from '@core/utils/typeboxCompiler'
import type { AnyModuleDefinition } from './types'

export class ModulePublishValidationError extends Error {
  readonly path: string
  constructor(path: string, message: string, options?: ErrorOptions) {
    super(path + ': ' + message, options)
    this.name = 'ModulePublishValidationError'
    this.path = path
  }
}

/** One hard, schema-owned boundary for every rendering of resolved props. */
export function validateModulePublishInput(
  definition: AnyModuleDefinition,
  props: Readonly<Record<string, unknown>>,
  settings: Readonly<Record<string, unknown>>,
  path: string,
): void {
  if (!definition.publishSchema) return
  let validator: ReturnType<typeof compiled>
  try { validator = compiled(definition.publishSchema) } catch (cause) {
    throw new ModulePublishValidationError(path + '/publishSchema', 'Invalid declarative module publish schema', { cause })
  }
  const input = { props, settings }
  if (validator.Check(input)) return
  const failure = validator.Errors(input).First()
  const message = typeof failure?.schema.description === 'string' ? failure.schema.description : failure?.message
  throw new ModulePublishValidationError(path + (failure?.path ?? ''), message ?? 'Invalid module publish input')
}
