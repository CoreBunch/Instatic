/**
 * Browser-side runners for the Visual Component tools.
 *
 * Split out of `executor.ts` for the same reason as `codeAssetTools.ts` and
 * `cssTools.ts`: the executor stays a dispatch table, and the component
 * domain — create/componentize, instance placement, params, prop bindings —
 * lives in one module.
 *
 * The store actions these wrap are deliberately forgiving: a missing VC or
 * param is a no-op, and `insertComponentRef` returns null on a prevented
 * cycle. That is right for a UI where the affordance cannot be reached in the
 * first place, and wrong for a tool caller who would read the silence as
 * success — so every runner re-checks its precondition and returns an error
 * naming what does exist.
 */

import { registry } from '@core/module-engine'
import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  type BindComponentPropInput,
  type BindComponentVariantInput,
  type CreateComponentInput,
  type InsertComponentInput,
  type SetComponentParamsInput,
} from '@core/ai'
import type { VisualComponent } from '@core/visualComponents'
import type { BaseNode } from '@core/page-tree'
import type { EditorStore } from '@site/store/types'
import { getAgentStoreApi } from './storeRef'

// Live access to the editor store. Routed through `./storeRef` so this module
// has no static import edge back into the store module.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

function componentsOf(store: EditorStore): readonly VisualComponent[] {
  return store.site?.visualComponents ?? []
}

function findComponent(store: EditorStore, componentId: string): VisualComponent | undefined {
  return componentsOf(store).find((vc) => vc.id === componentId)
}

/** Error text that names the components that DO exist, so the next call lands. */
function unknownComponentError(store: EditorStore, componentId: string): AiToolOutput {
  const known = componentsOf(store).map((vc) => `"${vc.name}" (${vc.id})`)
  return aiToolError(
    `Unknown Visual Component "${componentId}". ` +
      (known.length > 0
        ? `Available: ${known.join(', ')}.`
        : 'This site has no Visual Components yet — create one with site_create_component.'),
  )
}

// ---------------------------------------------------------------------------
// site_create_component
// ---------------------------------------------------------------------------

export function runCreateComponent(input: CreateComponentInput): AiToolOutput {
  // Both store actions throw VisualComponentNameError / VisualComponentRecursionError
  // on bad input; the executor's catch surfaces those messages verbatim and
  // they already name the offending value.
  const componentId = input.fromNodeId
    ? getStoreState().convertNodeToComponent(input.fromNodeId, input.name)
    : getStoreState().createVisualComponent(input.name)

  // Re-read: the action committed through Mutative, so a snapshot taken before
  // the call would not contain the new component.
  const created = findComponent(getStoreState(), componentId)
  return aiToolOk({
    componentId,
    name: input.name,
    ...(created ? { rootNodeId: created.tree.rootNodeId } : {}),
    ...(input.fromNodeId ? { componentizedFrom: input.fromNodeId, replacedByRef: true } : {}),
  })
}

// ---------------------------------------------------------------------------
// site_insert_component
// ---------------------------------------------------------------------------

export function runInsertComponent(input: InsertComponentInput): AiToolOutput {
  const store = getStoreState()
  const vc = findComponent(store, input.componentId)
  if (!vc) return unknownComponentError(store, input.componentId)

  const nodeId = store.insertComponentRef(input.parentId, input.componentId, input.index)
  if (!nodeId) {
    // insertComponentRef collapses both causes into null and they are not
    // distinguishable after the fact, so name both.
    return aiToolError(
      `Could not place "${vc.name}" under node ${input.parentId}. Either that parent does not ` +
        `exist in the active document, or the insertion would make a component contain itself ` +
        `(directly, or through another component).`,
    )
  }
  return aiToolOk({ nodeId, componentId: vc.id, name: vc.name })
}

// ---------------------------------------------------------------------------
// site_set_component_params
// ---------------------------------------------------------------------------

type ParamSpec = SetComponentParamsInput['params'][number]
type ParamMetaPatch = { required?: boolean; description?: string; enumOptions?: string[] }

/**
 * Resolve every requested param against the current list, rejecting the whole
 * call on the first problem. A param list left half-applied because entry 4
 * was invalid is worse than one not applied at all — the caller reads a
 * partial success and cannot tell which entries landed.
 */
function planParamChanges(
  vc: VisualComponent,
  specs: readonly ParamSpec[],
): { plan: { spec: ParamSpec; existingId: string | null }[] } | { error: string } {
  const plan: { spec: ParamSpec; existingId: string | null }[] = []
  const seen = new Set<string>()

  for (const spec of specs) {
    if (seen.has(spec.name)) {
      return { error: `Duplicate param name "${spec.name}" in this call — names must be unique.` }
    }
    seen.add(spec.name)

    const match = spec.id
      ? vc.params.find((p) => p.id === spec.id)
      : vc.params.find((p) => p.name === spec.name)

    if (spec.id && !match) {
      const known = vc.params.map((p) => `${p.name} (${p.id})`)
      return {
        error:
          `Unknown param id "${spec.id}" on "${vc.name}". ` +
          (known.length > 0
            ? `Existing params: ${known.join(', ')}. Omit \`id\` to create a new one.`
            : 'This component has no params yet — omit `id` to create one.'),
      }
    }

    const effectiveType = spec.type ?? match?.type ?? 'string'

    if (match && spec.type && spec.type !== match.type) {
      return {
        error:
          `Cannot change param "${match.name}" from ${match.type} to ${spec.type}. A param's type ` +
          `is fixed once instances override it and nodes bind to it. Omit \`type\` to keep it, or ` +
          `remove the param (removeMissing) and add it again under the new type.`,
      }
    }
    if (spec.enumOptions !== undefined && effectiveType !== 'enum') {
      return {
        error: `enumOptions is only meaningful on an enum param, but "${spec.name}" is ${effectiveType}.`,
      }
    }
    if (effectiveType === 'enum' && spec.enumOptions !== undefined && spec.enumOptions.length === 0) {
      return { error: `Param "${spec.name}" is an enum, so enumOptions cannot be empty.` }
    }

    plan.push({ spec, existingId: match?.id ?? null })
  }

  return { plan }
}

function paramMetaPatch(spec: ParamSpec): ParamMetaPatch {
  const patch: ParamMetaPatch = {}
  if (spec.required !== undefined) patch.required = spec.required
  if (spec.description !== undefined) patch.description = spec.description
  if (spec.enumOptions !== undefined) patch.enumOptions = spec.enumOptions
  return patch
}

export function runSetComponentParams(input: SetComponentParamsInput): AiToolOutput {
  const store = getStoreState()
  const vc = findComponent(store, input.componentId)
  if (!vc) return unknownComponentError(store, input.componentId)

  const planned = planParamChanges(vc, input.params)
  if ('error' in planned) return aiToolError(planned.error)

  const applied: { id: string; name: string; type: string; action: 'created' | 'updated' }[] = []
  const keptIds = new Set<string>()

  for (const { spec, existingId } of planned.plan) {
    const current = existingId ? vc.params.find((p) => p.id === existingId) : undefined
    const type = spec.type ?? current?.type ?? 'string'
    let paramId: string

    if (existingId) {
      paramId = existingId
      if (current && current.name !== spec.name) {
        // Throws VisualComponentParamNameError on a collision; the executor's
        // catch surfaces it with the offending name.
        store.renameParam(vc.id, paramId, spec.name)
      }
      if (spec.defaultValue !== undefined) {
        store.updateParamDefaultValue(vc.id, paramId, spec.defaultValue)
      }
    } else {
      paramId = store.addParam(vc.id, spec.name, type, spec.defaultValue)
    }

    const meta = paramMetaPatch(spec)
    if (Object.keys(meta).length > 0) store.updateParamMeta(vc.id, paramId, meta)

    keptIds.add(paramId)
    applied.push({ id: paramId, name: spec.name, type, action: existingId ? 'updated' : 'created' })
  }

  // `vc.params` is the pre-call snapshot, which is exactly the set to diff
  // against: the params that existed before and were not named in this call.
  const removed: { id: string; name: string }[] = []
  if (input.removeMissing) {
    for (const param of vc.params) {
      if (keptIds.has(param.id)) continue
      store.removeParamWithCleanup(vc.id, param.id)
      removed.push({ id: param.id, name: param.name })
    }
  }

  return aiToolOk({
    componentId: vc.id,
    params: applied,
    ...(removed.length > 0 ? { removed } : {}),
  })
}

// ---------------------------------------------------------------------------
// site_bind_component_prop
// ---------------------------------------------------------------------------

export function runBindComponentProp(
  input: BindComponentPropInput,
  node: BaseNode | null,
): AiToolOutput {
  const store = getStoreState()

  if (!input.paramId) {
    store.clearNodePropBinding(input.nodeId, input.propKey)
    return aiToolOk({ nodeId: input.nodeId, propKey: input.propKey, cleared: true })
  }

  const activeDocument = store.activeDocument
  if (activeDocument?.kind !== 'visualComponent') {
    return aiToolError(
      `Prop bindings exist only inside a Visual Component definition, but node ${input.nodeId} ` +
        `is on a page. To give a single instance its own value, set \`propOverrides\` on the ref ` +
        `node with site_update_node_props instead.`,
    )
  }
  if (!node) return aiToolError(`Node ${input.nodeId} was not found in the active document.`)

  const vc = findComponent(store, activeDocument.vcId)
  if (!vc) return unknownComponentError(store, activeDocument.vcId)

  const param = vc.params.find((p) => p.id === input.paramId)
  if (!param) {
    const known = vc.params.map((p) => `${p.name} (${p.id}, ${p.type})`)
    return aiToolError(
      `Unknown param "${input.paramId}" on component "${vc.name}". ` +
        (known.length > 0
          ? `Available: ${known.join(', ')}.`
          : 'This component has no params yet — declare them with site_set_component_params first.'),
    )
  }

  // A binding to a prop the module does not define renders nothing and leaves
  // no trace in the UI, so catch the typo here rather than at publish time.
  const definition = registry.get(node.moduleId)
  if (!definition) return aiToolError(`Unknown module on node ${input.nodeId}: ${node.moduleId}`)
  if (!definition.schema[input.propKey]) {
    const props = Object.keys(definition.schema)
    return aiToolError(
      `Module ${node.moduleId} has no prop "${input.propKey}". ` +
        (props.length > 0 ? `Available props: ${props.join(', ')}.` : 'It has no bindable props.'),
    )
  }

  store.setNodePropBinding(input.nodeId, input.propKey, input.paramId)
  return aiToolOk({
    nodeId: input.nodeId,
    propKey: input.propKey,
    paramId: param.id,
    paramName: param.name,
    paramType: param.type,
  })
}

// ---------------------------------------------------------------------------
// site_bind_component_variant
// ---------------------------------------------------------------------------

/**
 * Resolve a class SELECTOR (`btn-ghost` or `.btn-ghost`) to its stable id.
 * Names are what a caller can see and reason about; ids are what survives a
 * rename, so the binding stores the id.
 */
function resolveClassId(store: EditorStore, selectorOrId: string): string | null {
  const rules = store.site?.styleRules
  if (!rules) return null
  const key = selectorOrId.startsWith('.') ? selectorOrId.slice(1) : selectorOrId
  if (rules[key]) return key
  // Filter rather than find so an ambiguous name is rejected instead of
  // silently binding to whichever rule happened to be first.
  const matches = Object.values(rules).filter((rule) => rule.name === key)
  if (matches.length !== 1) return null
  return matches[0]?.id ?? null
}

export function runBindComponentVariant(
  input: BindComponentVariantInput,
  node: BaseNode | null,
): AiToolOutput {
  const store = getStoreState()

  const activeDocument = store.activeDocument
  if (activeDocument?.kind !== 'visualComponent') {
    return aiToolError(
      `A variant binding lives inside a Visual Component definition, but node ${input.nodeId} ` +
        `is on a page. To style one instance, put the class on the ref node with site_assign_class.`,
    )
  }
  if (!node) return aiToolError(`Node ${input.nodeId} was not found in the active component.`)

  const vc = findComponent(store, activeDocument.vcId)
  if (!vc) return unknownComponentError(store, activeDocument.vcId)

  const param = vc.params.find((p) => p.id === input.paramId)
  if (!param) {
    const known = vc.params.map((p) => `${p.name} (${p.id}, ${p.type})`)
    return aiToolError(
      `Unknown param "${input.paramId}" on component "${vc.name}". ` +
        (known.length > 0
          ? `Available: ${known.join(', ')}.`
          : 'Declare the param with site_set_component_params first.'),
    )
  }

  const entries = Object.entries(input.classByValue)
  if (entries.length === 0) {
    store.setNodeClassBinding(input.nodeId, input.paramId, {})
    return aiToolOk({ nodeId: input.nodeId, paramId: input.paramId, cleared: true })
  }

  // Resolve every class BEFORE writing: a binding half-resolved because entry 3
  // named a missing class would silently render some variants unstyled.
  const resolved: Record<string, string> = {}
  const unresolved: string[] = []
  for (const [value, selector] of entries) {
    const classId = resolveClassId(store, selector)
    if (classId) resolved[value] = classId
    else unresolved.push(`${value} → ${selector}`)
  }
  if (unresolved.length > 0) {
    return aiToolError(
      `These classes do not exist (or the name is ambiguous): ${unresolved.join(', ')}. ` +
        `Create them with site_apply_css first — a variant binding only selects between ` +
        `classes that already carry the styling.`,
    )
  }

  // An enum param whose options and mapped values disagree is the likeliest
  // authoring mistake, and it fails silently at render (the dropdown offers a
  // value that maps to nothing), so surface it as a warning rather than a hard
  // error — a partial map is legitimate when one option means "no class".
  const warnings: string[] = []
  if (param.type === 'enum') {
    const options = param.enumOptions ?? []
    const unknownValues = Object.keys(resolved).filter((value) => !options.includes(value))
    if (unknownValues.length > 0) {
      warnings.push(
        `Mapped value(s) not offered by the param's enumOptions and therefore unreachable: ` +
          `${unknownValues.join(', ')}. Options are: ${options.join(', ') || '(none)'}.`,
      )
    }
  } else {
    warnings.push(
      `Param "${param.name}" is ${param.type}, not enum — instances get a free-text field ` +
        `rather than a dropdown, so a typo silently renders no variant.`,
    )
  }

  store.setNodeClassBinding(input.nodeId, input.paramId, resolved)
  return aiToolOk({
    nodeId: input.nodeId,
    paramId: param.id,
    paramName: param.name,
    classByValue: resolved,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}
