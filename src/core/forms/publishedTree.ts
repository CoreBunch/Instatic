import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import { reindexNodeParents, getParent } from '@core/page-tree'
import { evaluateCondition, PropertyConditionSchema } from '@core/module-engine-schema'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { instantiateVCAtRef, resolveSlotName, safePropOverrides } from '@core/visualComponents'
import { composeTemplateChain, resolveTemplateChain, buildTemplateRenderContext, resolveDynamicProps, effectiveNodeBindings, parseTokenString } from '@core/templates'
import { derivePageFormSnapshots } from './snapshot'
import type { TemplateRenderDataContext } from '@core/templates'
import { FormConfigurationError } from './errors'
import { resolveSelectInitialValue } from './selectInitialValue'

/** Native composition and bindings give the server the same form definition as rendering. */
export function resolvePublishedFormPage(site: SiteDocument, page: Page): Page {
  const composed = composeTemplateChain(resolveTemplateChain(site, { kind: 'page' }), { kind: 'page', page })
  const context = buildTemplateRenderContext(page, site, undefined)
  return expandTree(site, { ...page, nodes: composed.nodes, rootNodeId: composed.rootNodeId }, context)
}

function expandTree(site: SiteDocument, page: Page, context: TemplateRenderDataContext): Page {
  const nodes: Record<string, PageNode> = {}
  function visit(id: string, source: Record<string, PageNode>, prefix: string, stack: Set<string>, inCmsForm = false): string | null {
    const node = source[id]
    if (!node || node.hidden) return null
    const props = resolveDynamicProps(node.props, effectiveNodeBindings(node), context)
    const cmsForm = inCmsForm || (node.moduleId === 'base.form' && props.mode !== 'request' && props.mode !== 'custom')
    if (cmsForm) {
      const fail = () => { throw new FormConfigurationError('CMS form definitions require page/site bindings; entry or request bindings need an entry-specific submission authority', `pages.${page.id}.nodes.${prefix + node.id}`) }
      function inspect(value: unknown) {
        if (typeof value === 'string' && parseTokenString(value).some((segment) => segment.kind === 'token' && ['currentEntry', 'parentEntry', 'route'].includes(segment.source))) fail()
        else if (Array.isArray(value)) value.forEach(inspect)
        else if (value && typeof value === 'object') Object.values(value).forEach(inspect)
      }
      inspect(node.props)
      if (Object.values(effectiveNodeBindings(node) ?? {}).some((binding) => ['currentEntry', 'parentEntry', 'route'].includes(binding.source))) fail()
    }
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = typeof props.componentId === 'string' ? props.componentId : ''
      const component = site.visualComponents.find((entry) => entry.id === componentId)
      if (!component) return null
      if (stack.has(componentId)) throw new Error('Recursive Visual Component in form definition')
      const slots: Record<string, string[]> = {}
      for (const childId of node.children) {
        const child = source[childId]
        if (child?.moduleId === 'base.slot-instance') slots[resolveSlotName(child.props)] = child.children
      }
      const instance = instantiateVCAtRef(component, safePropOverrides(node.props), slots, source, node.id)
      return visit(instance.rootNodeId, instance.nodes, prefix + node.id + ':', new Set([...stack, componentId]), cmsForm)
    }
    const nodeId = prefix + id
    const children = node.children.map((child) => visit(child, source, prefix, stack, cmsForm)).filter((child): child is string => child !== null)
    nodes[nodeId] = { ...node, id: nodeId, props, children }
    return nodeId
  }
  const rootNodeId = visit(page.rootNodeId, page.nodes, '', new Set())
  reindexNodeParents(nodes)
  return { ...page, rootNodeId: rootNodeId ?? page.rootNodeId, nodes }
}

export function derivePublishedPageFormSnapshots(site: SiteDocument, page: Page) {
  return derivePageFormSnapshots(resolvePublishedFormPage(site, page))
}

export function resolveInitialFormValues(site: SiteDocument, page: Page, formNodeId: string, context: TemplateRenderDataContext): Record<string, unknown> {
  const expanded = expandTree(site, { ...page, rootNodeId: formNodeId }, context)
  const values: Record<string, unknown> = Object.create(null)
  const sources = new Map<string, PageNode>()
  for (const node of Object.values(expanded.nodes)) {
    const name = typeof node.props.name === 'string' && node.props.name ? node.props.name : typeof node.props.fieldId === 'string' ? node.props.fieldId : ''
    if (!name || node.props.disabled) continue
    if (node.moduleId === 'base.select') {
      values[name] = resolveSelectInitialValue(node, (id) => expanded.nodes[id])
    } else if (['base.input', 'base.textarea', 'base.radio', 'base.checkbox'].includes(node.moduleId)) {
      if (['base.radio', 'base.checkbox'].includes(node.moduleId) && !node.props.checked) continue
      values[name] = node.props.value ?? (['base.radio', 'base.checkbox'].includes(node.moduleId) ? 'on' : '')
    } else continue
    sources.set(name, node)
  }
  // Only successful controls contribute to outputs and synchronized values.
  // Condition selectors are unconditional, as enforced by the native preflight.
  const successful = { ...values }
  for (const [name, node] of sources) {
    let parent = getParent(expanded, node.id)
    while (parent) {
      if (parent.moduleId === 'base.form-conditional' && compiledCheck(PropertyConditionSchema, parent.props.condition) && !evaluateCondition(parent.props.condition, values)) delete successful[name]
      parent = getParent(expanded, parent.id)
    }
  }
  return successful
}
