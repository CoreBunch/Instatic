/**
 * Completing a member form: what it still lacks for its action, and the
 * nodes that add it. Used by the form setup panel's "Add …" button.
 */
import type { ImportFragment } from '@core/htmlImport'
import type { MemberFormAction, MemberFormField } from '@core/members'
import { createNode, flattenSubtree, type Page, type PageNode } from '@core/page-tree'
import { FORM_CONTROL_MODULES, stringProp } from './formSettingsAnalysis'

export interface MemberFormMissing {
  fields: MemberFormField[]
  submit: boolean
  messages: boolean
  /** The action asks a yes-or-no question and the form has no button for "no". */
  secondary: boolean
}

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

/**
 * The nodes that complete a member form: one labelled input per missing
 * field, then (when the form has none) an error message, a success message
 * for an action that has one to show, a submit button and the action's
 * second button.
 */
export function memberFormFragment(
  action: MemberFormAction,
  formId: string,
  missing: MemberFormMissing,
): ImportFragment {
  const nodes: Record<string, PageNode> = {}
  const rootIds: string[] = []
  const add = (node: PageNode, root = true): PageNode => {
    nodes[node.id] = node
    if (root) rootIds.push(node.id)
    return node
  }
  for (const field of missing.fields) {
    if (field.inputType === 'hidden') {
      // Sent without asking: no label, and the value comes from where the form sits.
      add(createNode('base.input', { fieldId: field.name, name: field.name, inputType: 'hidden', value: field.value ?? '' }))
      continue
    }
    const wrapper = add(createNode('base.container', { tag: 'div' }))
    // The label names its input outright, so the pair is linked in the
    // published HTML itself and does not wait for the form runtime.
    const inputId = `${formId}-${field.name}`
    const label = add(createNode('base.label', { text: field.label, targetMode: 'explicit', targetId: inputId }), false)
    const input = add(
      createNode('base.input', {
        fieldId: field.name,
        name: field.name,
        id: inputId,
        inputType: field.inputType,
        autocomplete: field.autocomplete,
        required: true,
        // A profile form opens with the member's current value in place.
        ...(action.action === 'profile' ? { value: `{member.profile.${field.name}}` } : {}),
      }),
      false,
    )
    wrapper.children.push(label.id, input.id)
  }
  if (missing.messages) {
    add(createNode('base.form-message', { formId, kind: 'error', text: '' }))
    if (action.successMessage) add(createNode('base.form-message', { formId, kind: 'success', text: action.successMessage }))
  }
  const { choice } = action
  if (missing.submit) {
    add(createNode('base.submit', {
      label: action.submitLabel, disabled: false, formId: '',
      ...(choice ? { name: choice.name, value: choice.submitValue } : {}),
    }))
  }
  if (missing.secondary && choice) {
    add(createNode('base.submit', {
      label: choice.other.label, disabled: false, formId: '', name: choice.name, value: choice.other.value,
    }))
  }
  return { nodes, rootIds }
}
