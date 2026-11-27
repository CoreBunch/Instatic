/** Public presentation data for a device approval. Credentials stay in the handler. */
export const PAIR_FORM_ACTION = 'oauth/pair/approve'
export const approvalStates = {
  email: 'Email address',
  sent: 'Check your email',
  review: 'Review connection',
  approved: 'Connected',
  denied: 'Declined',
  closed: 'Request closed',
  error: 'Request error',
} as const

export type ApprovalState = keyof typeof approvalStates
export interface ApprovalView {
  state: ApprovalState
  name?: string
  code?: string
  access?: string
  device?: string
  email?: string
  account?: string
  message?: string
}

/** State groups are ordinary, editable containers with an attribute. */
export function approvalGroup(props: Record<string, unknown>): string | undefined {
  const attrs = props.htmlAttributes
  if (!attrs || typeof attrs !== 'object' || !('data-approval-state' in attrs)) return undefined
  return String(attrs['data-approval-state'])
}
