import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import { flattenSubtree, getParent } from '@core/page-tree'
import { PropertyConditionSchema, type PropertyCondition } from '@core/module-engine-schema'
import { normalizeIdentifierValue } from '@core/utils/identifier'
import { Value } from '@sinclair/typebox/value'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { FormConfigurationSchema, FormControlBehaviorSchema, TurnstileConfigurationSchema } from '@core/forms-schema'
import { resolvePublishedFormPage } from './publishedTree'
import { FormConfigurationError } from './errors'
const CONTROLS = new Set(['base.input', 'base.select', 'base.textarea', 'base.checkbox', 'base.radio'])

export function assertSiteForms(site: SiteDocument) {
  for (const page of site.pages) assertPageForms(resolvePublishedFormPage(site, page))
}
function fields(condition: PropertyCondition): string[] {
  if ('and' in condition) return condition.and.flatMap(fields)
  if ('or' in condition) return condition.or.flatMap(fields)
  return [condition.field]
}
function assertPageForms(page: Page) {
  const formIds = new Set<string>()
  function fail(node: PageNode, message: string): never { throw new FormConfigurationError(message, `pages.${page.id}.nodes.${node.id}`) }
  function nearestForm(node: PageNode) {
    let parent = getParent(page, node.id)
    while (parent) { if (parent.moduleId === 'base.form') return parent; parent = getParent(page, parent.id) }
    return null
  }
  for (const node of Object.values(page.nodes)) {
    if (['base.turnstile','base.form-conditional','base.form-output'].includes(node.moduleId) && !nearestForm(node)) fail(node, 'Native form behavior must belong to a form')
    if (node.moduleId !== 'base.form') continue
    if (nearestForm(node)) fail(node, 'Nested HTML forms are invalid')
    const configuration = Value.Default(FormConfigurationSchema, structuredClone(node.props))
    if (!compiledCheck(FormConfigurationSchema, configuration)) fail(node, 'Invalid form configuration')
    const formId = normalizeIdentifierValue(configuration.formId, 'form')
    if (formIds.has(formId)) fail(node, 'Duplicate form ID on the rendered page')
    formIds.add(formId)
    let ancestor = getParent(page, node.id)
    while (ancestor) {
      if (ancestor.moduleId === 'base.loop') fail(node, 'Forms require a stable page instance outside content loops')
      ancestor = getParent(page, ancestor.id)
    }
    if (configuration.mode === 'request') {
      let endpoint: URL
      try { endpoint = new URL(configuration.action, 'https://instatic.invalid') } catch { fail(node, 'Invalid request endpoint') }
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !configuration.action.trim() || configuration.action.startsWith('//')) fail(node, 'Request endpoints require a relative or HTTP(S) URL without credentials')
      if (configuration.responseSuccessField === configuration.responseMessageField) fail(node, 'Success and message response fields must be distinct')
    }
    const descendants = flattenSubtree(page, node.id).map((id) => page.nodes[id]).filter((child) => child && child.id !== node.id)
    const controlByName = new Map<string, PageNode>()
    for (const control of descendants.filter((entry) => CONTROLS.has(entry.moduleId))) {
      const name = String(control.props.name || control.props.fieldId || '')
      if (!name) continue
      const previous = controlByName.get(name)
      if (previous && !(previous.moduleId === 'base.radio' && control.moduleId === 'base.radio' && previous.props.fieldId === control.props.fieldId)) fail(control, 'Duplicate control name')
      controlByName.set(name, control)
    }
    function assertCondition(owner: PageNode, value: unknown) {
      if (value === undefined || value === null) return
      if (!compiledCheck(PropertyConditionSchema, value)) fail(owner, 'Invalid declarative condition')
      for (const name of fields(value)) {
        const selector = controlByName.get(name)
        if (!selector || selector.props.disabled || selector.props.valueSourceField || selector.props.multiple) fail(owner, `Condition requires an enabled scalar control: ${name}`)
        let parent = getParent(page, selector.id)
        while (parent && parent.id !== node.id) {
          if (parent.moduleId === 'base.form-conditional' && parent.props.condition) fail(owner, `Condition selectors must be outside conditional groups: ${name}`)
          parent = getParent(page, parent.id)
        }
      }
    }
    let hasBehavior = false
    let captchaCount = 0
    for (const child of descendants) {
      if (child.moduleId === 'base.form-conditional') { hasBehavior = true; assertCondition(child, child.props.condition) }
      if (child.moduleId === 'base.form-output') {
        hasBehavior = true
        if (!controlByName.has(String(child.props.fieldName))) fail(child, 'Output requires an existing control name')
      }
      if (CONTROLS.has(child.moduleId)) {
        const behavior = Value.Default(FormControlBehaviorSchema, Object.fromEntries(Object.keys(FormControlBehaviorSchema.properties).filter((key) => Object.hasOwn(child.props, key)).map((key) => [key, child.props[key]])))
        if (!compiledCheck(FormControlBehaviorSchema, behavior)) fail(child, 'Invalid native control behavior')
        assertCondition(child, child.props.requiredWhen)
        if (child.props.requiredWhen || child.props.queryParameter || child.props.lockQueryValue || child.props.valueSourceField || child.props.requiredMessage || child.props.invalidMessage) hasBehavior = true
        if (child.props.valueSourceField) {
          const source = controlByName.get(String(child.props.valueSourceField))
          if (!source || source.props.valueSourceField || child.moduleId !== 'base.input' || child.props.inputType !== 'hidden' || child.props.queryParameter) fail(child, 'Synchronized values require a hidden input and a direct source control')
          if (source.props.disabled || source.props.multiple || ['base.checkbox', 'base.radio'].includes(source.moduleId) || source.props.inputType === 'file') fail(child, 'Synchronized values require an enabled scalar source that is always submitted')
          let parent = getParent(page, source.id)
          while (parent && parent.id !== node.id) {
            if (parent.moduleId === 'base.form-conditional' && parent.props.condition) fail(child, 'Synchronized source controls must be outside conditional groups')
            parent = getParent(page, parent.id)
          }
        }
        if (child.props.queryParameter && (['base.radio', 'base.checkbox'].includes(child.moduleId) || child.props.multiple || child.props.inputType === 'file')) fail(child, 'Query initialization requires a single text or select value')
        if (child.props.lockQueryValue && (!child.props.queryParameter || (child.moduleId === 'base.input' && ['hidden', 'file', 'range'].includes(String(child.props.inputType))))) fail(child, 'Query locking requires a declared query parameter on a text or select control supporting readonly semantics')
        if (child.props.lockQueryValue && behavior.resetBehavior === 'clear') fail(child, 'A locked query value cannot be cleared by reset')
        if (child.props.valueSourceField && behavior.resetBehavior !== 'initial') fail(child, 'Synchronized values reset through their source control')
        if (child.props.inputType === 'file' && behavior.resetBehavior === 'preserve') fail(child, 'File inputs cannot preserve selected files after reset')
        if (behavior.resetBehavior !== 'initial') hasBehavior = true
      }
      if (child.moduleId === 'base.turnstile') {
        hasBehavior = true; captchaCount++
        if (configuration.mode === 'cms') fail(child, 'CMS forms use native challenges; Turnstile requires a recipient with server-side verification')
        if (typeof child.props.siteKey !== 'string' || !child.props.siteKey.trim()) fail(child, 'Configure an explicit public Turnstile site key')
        if (!compiledCheck(TurnstileConfigurationSchema, child.props)) fail(child, 'Invalid Turnstile configuration; use a documented language code')
        if (!/^[a-zA-Z0-9_-]{0,32}$/.test(child.props.action)) fail(child, 'Invalid Turnstile action')
        let parent = getParent(page, child.id)
        while (parent && parent.id !== node.id) {
          if (parent.moduleId === 'base.form-conditional' && parent.props.condition) fail(child, 'Verification widgets must be outside conditional groups')
          parent = getParent(page, parent.id)
        }
      }
    }
    if (captchaCount > 1) fail(node, 'A form supports one Turnstile widget')
    if ((configuration.mode === 'cms' || (configuration.mode === 'request' && configuration.encoding === 'json')) && descendants.some((child) => child.moduleId === 'base.input' && child.props.inputType === 'file')) fail(node, 'File inputs require multipart submission to a declared recipient')
    if (configuration.mode === 'custom' && hasBehavior && !configuration.enhance) fail(node, 'Enable form behavior for an HTML action using native conditions or verification')
  }
}
