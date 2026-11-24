import type { ImportFragment } from '@core/htmlImport'
import { PAIR_FORM_ACTION, approvalStates, type ApprovalState, type MemberFormAction, type MemberFormField } from '@core/members'
import { appPairFormParts } from './appPairFormParts'
import { createNode, type PageNode } from '@core/page-tree'

export interface MemberFormMissing {
  states?: ApprovalState[]
  fields: MemberFormField[]
  submit: boolean
  messages: boolean
  /** The action asks a yes-or-no question and the form has no button for "no". */
  secondary: boolean
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
  if (action.action === PAIR_FORM_ACTION) {
    return appPairFormParts(formId, missing.states ?? Object.keys(approvalStates) as ApprovalState[])
  }
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
