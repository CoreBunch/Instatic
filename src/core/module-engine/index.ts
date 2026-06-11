/**
 * Module engine — public barrel.
 *
 * External consumers import from here; internal files import via relative
 * paths directly from their sibling modules.
 */

export type {
  ModuleDefinition,
  AnyModuleDefinition,
  IModuleRegistry,
  ModuleDependencies,
  RenderOutput,
  ModuleComponentProps,
  InlineEditBinding,
  NodeWrapperProps,
} from './types'

export type {
  PropertySchema,
  PropertyControl,
  PropertyControlLayout,
  TextControlNormalize,
  PropertyCondition,
} from './propertySchema'

export {
  PropertyControlSchema,
  PropertySchemaSchema,
  resolvePropertyControlCategory,
} from './propertySchema'

export {
  createModuleImportMap,
  resolveDependencyUrl,
} from './runtimeResolver'

export type {
  NormalizedModuleDependency,
  SiteModuleDependencyUsage,
} from './dependencies'

export {
  normalizeModuleDependencies,
  getMissingModuleDependencies,
  getSiteModuleDependencyUsage,
  getSiteDependencyVersion,
} from './dependencies'

export { registry } from './registry'

export { validateNodeProps } from './validateNodeProps'

export { resolveHtmlTagBadge } from './htmlTagBadge'
