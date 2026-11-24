/**
 * Completing a member form: what it still lacks for its action, and the
 * nodes that add it. Used by the form setup panel's "Add …" button.
 */
import type { MemberFormMissing } from '@core/memberForms'
import { approvalGroup, approvalStates, PAIR_FORM_ACTION, type ApprovalState, type MemberFormAction } from '@core/members'
import { flattenSubtree, type Page } from '@core/page-tree'
import { FORM_CONTROL_MODULES, stringProp } from './formSettingsAnalysis'

/** The `name` of every control inside a form. */
function controlNamesInForm(page: Page, formNodeId: string): Set<string> {
  const names = new Set<string>()
  for (const nodeId of flattenSubtree(page, formNodeId)) {
    const node = page.nodes[nodeId]
    if (!node || !FORM_CONTROL_MODULES.has(node.moduleId)) continue
    const name = stringProp(node, 'name', stringProp(node, 'fieldId', ''))
    if (name) names.add(name)
  }
  return names
}

function formHasModule(page: Page, formNodeId: string, moduleId: string): boolean {
  return flattenSubtree(page, formNodeId).some((nodeId) => page.nodes[nodeId]?.moduleId === moduleId)
}

/** Does the form hold a submit button that sends `name=value`? */
function formHasButton(page: Page, formNodeId: string, name: string, value: string): boolean {
  return flattenSubtree(page, formNodeId).some((nodeId) => {
    const node = page.nodes[nodeId]
    return node?.moduleId === 'base.submit' && stringProp(node, 'name', '') === name && stringProp(node, 'value', '') === value
  })
}

/** What a member form still lacks for its action: fields, a submit button, messages, a second button. */
export function missingMemberFormParts(
  page: Page,
  formNodeId: string,
  action: MemberFormAction,
): MemberFormMissing {
  if (action.action === PAIR_FORM_ACTION) {
    const present = new Set(flattenSubtree(page, formNodeId).map(id => approvalGroup(page.nodes[id].props)))
    const states = (Object.keys(approvalStates) as ApprovalState[]).filter(state => !present.has(state))
    return { states, fields: [], submit: false, secondary: false, messages: false }
  }
  const names = controlNamesInForm(page, formNodeId)
  return {
    fields: action.fields.filter((field) => !names.has(field.name)),
    // A yes-or-no form needs the button that says "yes", not just any button.
    submit: action.choice
      ? !formHasButton(page, formNodeId, action.choice.name, action.choice.submitValue)
      : !formHasModule(page, formNodeId, 'base.submit'),
    messages: !formHasModule(page, formNodeId, 'base.form-message'),
    secondary: action.choice !== undefined && !formHasButton(page, formNodeId, action.choice.name, action.choice.other.value),
  }
}
