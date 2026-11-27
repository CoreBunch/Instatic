import { approvalStates, type ApprovalState } from '@core/members'
import { createNode, type PageNode } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'

/** Ordinary page nodes: the installer can edit every heading, field and button. */
export function appPairFormParts(formId: string, states: readonly ApprovalState[]): ImportFragment {
  const nodes: Record<string, PageNode> = {}
  const rootIds: string[] = []
  const add = (module: string, props: PageNode['props'], parent?: PageNode) => {
    const node = createNode(module, props)
    nodes[node.id] = node
    if (parent) {
      parent.children.push(node.id)
      node.parentId = parent.id
    } else rootIds.push(node.id)
    return node
  }
  const headings: Record<ApprovalState, string> = {
    email: 'Connect {member.appRequest.name}', review: 'Connect {member.appRequest.name}',
    sent: 'Check your email', approved: 'App connected', denied: 'Connection declined',
    closed: 'Connection request closed', error: 'Unable to continue',
  }
  const descriptions: Record<ApprovalState, string> = {
    email: 'Match this code with the one in your app, then enter your member email.',
    review: 'Allow access only if this code matches the one in your app.',
    sent: 'If this email is linked to a member account, you’ll receive a link to review the request.',
    approved: 'Return to {member.appRequest.name} to continue.',
    denied: '{member.appRequest.name} was denied access. You can close this page.',
    closed: 'Start a new sign-in from your app to get a fresh code.',
    error: '{member.appRequest.message}',
  }
  for (const state of states) {
    const group = add('base.container', { tag: 'section', htmlAttributes: { 'data-approval-state': state } })
    group.label = approvalStates[state]
    const text = (content: string, tag = 'p', part?: string) => add('base.text', {
      tag, text: content, ...(part ? { htmlAttributes: { 'data-approval-part': part } } : {}),
    }, group)
    const button = (label: string, value: string) => add('base.submit', { label, name: 'action', value, formId: '', disabled: false }, group)
    text(headings[state], 'h1')
    text(descriptions[state])
    if (state === 'email' || state === 'review') {
      text('{member.appRequest.code}', 'p', 'code')
    }
    if (state === 'email') {
      const id = formId + '-email'
      add('base.label', { text: 'Email address', targetMode: 'explicit', targetId: id }, group)
      add('base.input', { id, fieldId: 'email', name: 'email', inputType: 'email', required: true,
        placeholder: 'you@example.com', autocomplete: 'email' }, group)
      button('Send approval link', 'email')
    }
    if (state === 'review') {
      text('Account', 'p', 'label')
      text('{member.appRequest.email}')
      text('Requested access', 'p', 'label')
      text('{member.appRequest.access}')
      text('{member.appRequest.device}', 'p', 'device')
      add('base.input', { fieldId: 'account', name: 'account', inputType: 'hidden', value: '{member.appRequest.account}' }, group)
      button('Allow access', 'allow')
      button('Decline', 'deny')
    }
  }
  return { nodes, rootIds }
}
