import { memberFormAction } from '@core/members'
import { memberFormFragment } from '@core/memberForms'
import { JSDOM } from 'jsdom'
import { importHtml } from '@core/htmlImport'
import { createNode, isGeneratedClassLocked, updateNodeProps, type Page, type SiteShell, type StyleRule } from '@core/page-tree'
import { cssToStyleRules, insertImportedFragment } from '@core/siteImport'
import { Type, type Static } from '@core/utils/typeboxHelpers'

const id = Type.String({ minLength: 1 })
const css = Type.Object({
  property: Type.String({ pattern: '^(--[a-zA-Z0-9_-]+|[a-zA-Z][a-zA-Z0-9-]*)$' }),
  value: Type.Union([Type.String(), Type.Null()], { description: 'CSS value, or null to remove the declaration' }),
})
const operations = Type.Union([
  Type.Object({ op: Type.Literal('text'), node: id, value: Type.String() }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('inline'), node: id, ...css.properties }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('rule'), rule: id, context: Type.Optional(id), ...css.properties }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('memberForm'), parent: id, action: id, successPath: Type.Optional(Type.String({ pattern: '^/(?!/)' })) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal('insertHtml'), parent: id, html: Type.String({ minLength: 1, maxLength: 100000 }) }, { additionalProperties: false }),
])
export const CanvasEditSchema = Type.Object({
  revision: Type.String({ minLength: 1, description: 'Revision returned by canvas inspect for this page and branch' }),
  edits: Type.Array(operations, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false })

function insertMarkup(page: Page, site: SiteShell, parentId: string, html: string) {
  const { window } = new JSDOM('')
  try {
    const fragment = importHtml(html, { parseDocument: source => new window.DOMParser().parseFromString(source, 'text/html') })
    if (!fragment.rootIds.length) throw new Error('HTML must contain at least one editable element')
    const css = cssToStyleRules(fragment.styleCss, { breakpoints: site.breakpoints, sheetConstructor: window.CSSStyleSheet })
    if (!insertImportedFragment(page, site, parentId, fragment, { styleRules: css.rules, conditions: css.conditions })) {
      throw new Error('Choose a page container as the parent')
    }
    return { op: 'insertHtml', parent: parentId, added: fragment.rootIds, stripped: fragment.stripped, warnings: [...fragment.warnings, ...css.warnings] }
  } finally { window.close() }
}

export function applyCanvasEdit(page: Page, site: SiteShell, edit: Static<typeof operations>) {
  if (edit.op === 'memberForm') {
    const action = memberFormAction(edit.action)
    if (!action) throw new Error('Unknown member form action. Use api lookup membership.')
    const formId = 'form-' + crypto.randomUUID()
    const form = createNode('base.form', { formId, mode: 'member', memberAction: action.action,
      successBehavior: edit.successPath ? 'redirect' : 'message', redirectUrl: edit.successPath ?? '', successMessage: action.successMessage })
    const parts = memberFormFragment(action, formId, { fields: [...action.fields], submit: true, messages: true, secondary: !!action.choice })
    form.children = parts.rootIds
    parts.nodes[form.id] = form
    if (!insertImportedFragment(page, site, edit.parent, { rootIds: [form.id], nodes: parts.nodes })) throw new Error('Choose a page container as the parent')
    return { op: edit.op, node: form.id, action: action.action, successPath: edit.successPath }
  }
  if (edit.op === 'insertHtml') return insertMarkup(page, site, edit.parent, edit.html)
  if (edit.op === 'text') {
    const node = Object.hasOwn(page.nodes, edit.node) && page.nodes[edit.node]
    if (!node || node.moduleId !== 'base.text') throw new Error('Choose an editable text node from inspect')
    if (node.propBindings?.text || node.dynamicBindings?.text) throw new Error('This text is bound to data. Edit its source instead.')
    const before = node.props.text
    updateNodeProps(page, edit.node, { text: edit.value })
    return { op: edit.op, node: edit.node, before, after: edit.value }
  }
  const property = edit.property.startsWith('--') ? edit.property : edit.property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  if (Object.hasOwn(Object.prototype, property)) throw new Error('Invalid CSS property')
  let declarations: Record<string, unknown>
  let priorities: Record<string, unknown> | undefined
  let sharedRule: StyleRule | undefined
  if (edit.op === 'inline') {
    const node = Object.hasOwn(page.nodes, edit.node) && page.nodes[edit.node]
    if (!node) throw new Error('Unknown page node')
    declarations = node.inlineStyles ??= {}
  } else {
    const rule = Object.hasOwn(site.styleRules, edit.rule) && site.styleRules[edit.rule]
    if (!rule || isGeneratedClassLocked(rule) || rule.rawCss) throw new Error('Choose an editable declaration rule from inspect')
    sharedRule = rule
    if (edit.context) {
      if (Object.hasOwn(Object.prototype, edit.context) || ![...site.breakpoints, ...(site.conditions ?? [])].some(c => c.id === edit.context)) throw new Error('Unknown style context')
      declarations = rule.contextStyles[edit.context] ??= {}
      priorities = rule.contextStylePriorities?.[edit.context]
    } else {
      declarations = rule.styles
      priorities = rule.stylePriorities
    }
  }
  const before = declarations[property] ?? null
  if (edit.value === null) {
    delete declarations[property]
    if (priorities) delete priorities[property]
  } else declarations[property] = edit.value
  if (sharedRule && before !== edit.value) sharedRule.updatedAt = Date.now()
  return { ...edit, property, before, after: edit.value }
}
