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
  RenderOutput,
  CspDirective,
  CspSourceRequirement,
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
  PropertyConditionSchema,
  PropertyControlSchema,
  PropertySchemaSchema,
  resolvePropertyControlCategory,
} from './propertySchema'

export {
  createModuleImportMap,
  resolveDependencyUrl,
} from './runtimeResolver'

export type {
  SiteModuleDependencyUsage,
} from './dependencies'

export {
  normalizeModuleDependencies,
  getMissingModuleDependencies,
  getSiteModuleDependencyUsage,
  getSiteDependencyVersion,
} from './dependencies'

export { registry } from './registry'

export { parseModuleProps, ModulePropsValidationError } from './parseModuleProps'

export { resolveHtmlTagBadge } from './htmlTagBadge'

export { ModuleAssetsSchema, ModuleAssetUsageSchema } from './moduleAssets'
export type { ModuleAssets, ModuleAssetUsage } from './moduleAssets'
