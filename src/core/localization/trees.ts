import type { BaseNode, NodeTree } from '@core/page-tree'
import type { LocaleNodeOverride, LocaleTreeCell, LocaleTreeOverrides } from '@core/localization-schema'
import { LocaleTreeCellSchema } from '@core/localization-schema'
import type { PropertySchema } from '@core/module-engine'
import { resolvePropertyControlCategory } from '@core/module-engine'
import { Type } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { deepEqual } from '@core/utils/deepEqual'
import { cloneContentValue } from './contentValues'
import { LocalizationValidationError } from './errors'

export type PropertyLocalization = boolean | ReadonlySet<string>
export type PropertyLocalizationPolicy = (node: BaseNode, key: string) => PropertyLocalization
const PropertyObjectSchema = Type.Record(Type.String(), Type.Unknown())

export function localizedObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!compiledCheck(PropertyObjectSchema, value)) throw new LocalizationValidationError('property', 'Expected a parameter value map.')
  return value
}

/** Capture individual map entries, keeping other inherited values live. */
export function captureLocalizedObjectChanges(before: unknown, after: unknown, previous: unknown, allowed: ReadonlySet<string>, allowSharedEdits = false): Record<string, unknown> {
  const beforeValues = localizedObject(before)
  const afterValues = localizedObject(after)
  const result = cloneContentValue(localizedObject(previous))
  for (const key of new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)])) {
    if (Object.hasOwn(beforeValues, key) === Object.hasOwn(afterValues, key) && deepEqual(beforeValues[key], afterValues[key])) continue
    if (!allowed.has(key)) {
      if (allowSharedEdits) continue
      throw new LocalizationValidationError(key, 'This parameter is shared across languages.')
    }
    if (afterValues[key] !== undefined && afterValues[key] !== null && typeof afterValues[key] !== 'string') {
      throw new LocalizationValidationError(key, 'Localized content parameters require a string or null value.')
    }
    if (!Object.hasOwn(afterValues, key) || afterValues[key] === undefined) delete result[key]
    else Object.defineProperty(result, key, { value: cloneContentValue(afterValues[key]), enumerable: true, configurable: true, writable: true })
  }
  return result
}

/** Missing body means inheritance. A full independent tree is never an override. */
export function parseLocaleTreeCell(value: unknown, path = 'body'): LocaleTreeCell {
  if (value === undefined) return { nodes: {} }
  if (!compiledCheck(LocaleTreeCellSchema, value)) {
    throw new LocalizationValidationError(path, 'Expected localized node properties and visibility overrides.')
  }
  return value
}

/** Property groups arrange controls; their children still address flat prop keys. */
export function getLocalizablePropertyKeys(schema: PropertySchema): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const [key, control] of Object.entries(schema)) {
    if (control.type === 'group') {
      for (const childKey of getLocalizablePropertyKeys(control.children)) keys.add(childKey)
    } else if (!control.hidden && resolvePropertyControlCategory(control) === 'content') {
      keys.add(key)
    }
  }
  return keys
}

/**
 * Compose only values onto one shared tree. Source and target use the same
 * override representation. This is a detached projection, never a persistence
 * replacement for the shared tree. Page metadata survives the generic return.
 * Stale overrides for deleted shared nodes remain inert.
 */
export function materializeLocalizedTree<TTree extends NodeTree>(
  sharedTree: TTree,
  sourceOverrides: LocaleTreeOverrides = {},
  localeOverrides: LocaleTreeOverrides = {},
): TTree {
  const result = cloneContentValue(sharedTree)
  for (const overrides of [sourceOverrides, localeOverrides]) {
    for (const [nodeId, override] of Object.entries(overrides)) {
      if (!Object.hasOwn(result.nodes, nodeId)) continue
      const node = result.nodes[nodeId]
      if (override.props) {
        const props = cloneContentValue(override.props)
        if (node.moduleId === 'base.visual-component-ref' && Object.hasOwn(props, 'propOverrides')) {
          props.propOverrides = { ...localizedObject(node.props.propOverrides), ...localizedObject(props.propOverrides) }
        }
        node.props = { ...node.props, ...props }
      }
      if (override.hidden !== undefined) node.hidden = override.hidden
    }
  }
  return result
}

function sharedNodeFields(node: BaseNode): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'props' && key !== 'hidden'))
}

function captureNodeOverride(
  beforeNode: BaseNode | undefined,
  afterNode: BaseNode,
  override: LocaleNodeOverride,
  canLocalizeProperty: PropertyLocalizationPolicy,
  allowSharedEdits: boolean,
): LocaleNodeOverride {
  const beforeProps = beforeNode?.props ?? {}
  const propKeys = new Set([...Object.keys(beforeProps), ...Object.keys(afterNode.props)])
  for (const key of propKeys) {
    const hadValue = Object.hasOwn(beforeProps, key)
    const hasValue = Object.hasOwn(afterNode.props, key)
    if (hadValue === hasValue && deepEqual(beforeProps[key], afterNode.props[key])) continue
    const policy = canLocalizeProperty(afterNode, key)
    if (!policy) {
      if (allowSharedEdits) continue
      throw new LocalizationValidationError(`nodes.${afterNode.id}.props.${key}`, 'This property is shared across languages.')
    }
    if (typeof policy !== 'boolean') {
      const values = captureLocalizedObjectChanges(beforeProps[key], afterNode.props[key], override.props?.[key], policy, allowSharedEdits)
      if (Object.keys(values).length) override.props = { ...override.props, [key]: values }
      else if (override.props) delete override.props[key]
    } else if (hasValue && afterNode.props[key] !== undefined) {
      override.props = { ...override.props, [key]: cloneContentValue(afterNode.props[key]) }
    } else if (override.props) {
      delete override.props[key]
    }
  }
  if (beforeNode?.hidden !== afterNode.hidden) {
    if (afterNode.hidden === undefined) delete override.hidden
    else override.hidden = afterNode.hidden
  }
  if (override.props && Object.keys(override.props).length === 0) delete override.props
  return override
}

/**
 * Capture edits relative to the displayed projection, preserving explicit
 * overrides even when they equal the source. Comparing against the source
 * would accidentally copy inherited fields and stop future inheritance.
 * Deleting a projected prop resets that prop to inheritance; null and empty
 * strings are ordinary, intentionally localized values.
 */
export function extractLocalizedTreeChanges(
  before: NodeTree,
  after: NodeTree,
  previousOverrides: LocaleTreeOverrides,
  canLocalizeProperty: PropertyLocalizationPolicy,
): LocaleTreeOverrides {
  if (before.rootNodeId !== after.rootNodeId) {
    throw new LocalizationValidationError('rootNodeId', 'The root node is shared across languages.')
  }
  if (!deepEqual(Object.keys(before.nodes).sort(), Object.keys(after.nodes).sort())) {
    throw new LocalizationValidationError('nodes', 'Add and remove nodes in the shared structure.')
  }

  const result = cloneContentValue(previousOverrides)
  for (const [nodeId, beforeNode] of Object.entries(before.nodes)) {
    const afterNode = after.nodes[nodeId]
    if (!deepEqual(sharedNodeFields(beforeNode), sharedNodeFields(afterNode))) {
      throw new LocalizationValidationError(`nodes.${nodeId}`, 'Node structure and design are shared across languages.')
    }
    const override = captureNodeOverride(
      beforeNode, afterNode, Object.hasOwn(result, nodeId) ? result[nodeId] : {}, canLocalizeProperty, false,
    )
    if (Object.keys(override).length > 0) {
      Object.defineProperty(result, nodeId, { value: override, enumerable: true, configurable: true, writable: true })
    } else {
      delete result[nodeId]
    }
  }
  return result
}

/**
 * Source authoring can change shared structure and local content in one edit.
 * Existing baseline content is retained verbatim; newly authored content is
 * kept in the locale overlay. This prevents editing a source translation from
 * writing its projected content into every language's shared tree.
 */
export function splitLocalizedTree<TTree extends NodeTree>(
  previousSharedTree: TTree,
  before: NodeTree,
  after: TTree,
  previousOverrides: LocaleTreeOverrides,
  canLocalizeProperty: PropertyLocalizationPolicy,
): { sharedTree: TTree; localeOverrides: LocaleTreeOverrides } {
  const sharedTree = cloneContentValue(after)
  const localeEntries: [string, LocaleNodeOverride][] = []
  for (const [nodeId, afterNode] of Object.entries(after.nodes)) {
    const existingShared = Object.hasOwn(previousSharedTree.nodes, nodeId) ? previousSharedTree.nodes[nodeId] : undefined
    const sharedNode = existingShared?.moduleId === afterNode.moduleId ? existingShared : undefined
    const existingBefore = Object.hasOwn(before.nodes, nodeId) ? before.nodes[nodeId] : undefined
    const beforeNode = existingBefore?.moduleId === afterNode.moduleId ? existingBefore : undefined
    const previous = beforeNode && Object.hasOwn(previousOverrides, nodeId) ? previousOverrides[nodeId] : {}
    const override = captureNodeOverride(beforeNode, afterNode, cloneContentValue(previous), canLocalizeProperty, true)
    const sharedProps = sharedTree.nodes[nodeId].props
    for (const key of new Set([...Object.keys(sharedProps), ...Object.keys(sharedNode?.props ?? {})])) {
      const policy = canLocalizeProperty(afterNode, key)
      if (!policy) continue
      if (typeof policy !== 'boolean') {
        const values = { ...localizedObject(sharedProps[key]) }
        const baseline = localizedObject(sharedNode?.props[key])
        for (const parameter of policy) {
          if (Object.hasOwn(baseline, parameter)) values[parameter] = cloneContentValue(baseline[parameter])
          else delete values[parameter]
        }
        sharedProps[key] = values
        continue
      }
      if (sharedNode && Object.hasOwn(sharedNode.props, key)) {
        Object.defineProperty(sharedProps, key, {
          value: cloneContentValue(sharedNode.props[key]), enumerable: true, configurable: true, writable: true,
        })
      } else {
        delete sharedProps[key]
      }
    }
    if (sharedNode?.hidden === undefined) delete sharedTree.nodes[nodeId].hidden
    else sharedTree.nodes[nodeId].hidden = sharedNode.hidden
    if (Object.keys(override).length > 0) localeEntries.push([nodeId, override])
  }
  return { sharedTree, localeOverrides: Object.fromEntries(localeEntries) }
}

/** Explicit reset resumes inheritance, even when the current translation matches it. */
export function resetLocalizedNodeProperty(
  overrides: LocaleTreeOverrides,
  nodeId: string,
  property: string,
): LocaleTreeOverrides {
  const result = cloneContentValue(overrides)
  if (!Object.hasOwn(result, nodeId)) return result
  const override = result[nodeId]
  if (property === 'hidden') delete override.hidden
  if (override.props) {
    delete override.props[property]
    if (Object.keys(override.props).length === 0) delete override.props
  }
  if (Object.keys(override).length === 0) delete result[nodeId]
  return result
}
