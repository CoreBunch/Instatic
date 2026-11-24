import { useState } from 'react'
import type { Page } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { approvalStates, PAIR_FORM_ACTION, type ApprovalState } from '@core/members'
import { Select } from '@ui/components/Select'

export function useAppPairPreview(canvasPage: Page | null, pagePreviewContext: TemplateRenderDataContext | undefined) {
  const hasPairForm = canvasPage && Object.values(canvasPage.nodes).some(node =>
    node.moduleId === 'base.form' && node.props.mode === 'member' && node.props.memberAction === PAIR_FORM_ACTION)
  const [approvalState, setApprovalState] = useState<ApprovalState>('email')
  const templatePreviewContext = hasPairForm ? {
    ...pagePreviewContext, entryStack: pagePreviewContext?.entryStack ?? [],
    approval: { state: approvalState, name: 'Studio app', code: '7C2A-8F14',
      email: 'alex@example.com', access: 'Which memberships and access you hold',
      device: 'Studio laptop', message: 'Please review the request and try again.' },
  } : pagePreviewContext
  const stateControl = hasPairForm ? (
    <Select aria-label="Approval preview state" fieldSize="sm" value={approvalState}
      onChange={event => setApprovalState(event.currentTarget.value as ApprovalState)}>
      {Object.entries(approvalStates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select>
  ) : null
  return { templatePreviewContext, stateControl }
}
