import type { Page, PageNode } from '@core/page-tree'
import { normalizeIdentifierValue } from '@core/utils/identifier'
import type {
  FormControlBinding,
  PublishedFormLabel,
  PublishedFormMessage,
  PublishedFormSnapshot,
  PublishedFormSubmit,
} from './schemas'

const FORM_CONTROL_MODULES = new Set([
  'base.input',
  'base.textarea',
  'base.select',
  'base.checkbox',
  'base.radio',
])

export function derivePageFormSnapshots(page: Page): PublishedFormSnapshot[] {
  const snapshots: PublishedFormSnapshot[] = []

  for (const nodeId of walkTree(page, page.rootNodeId)) {
    const node = page.nodes[nodeId]
    if (!node || node.moduleId !== 'base.form') continue
    const mode = stringProp(node, 'mode', 'cms')
    if (mode !== 'cms') continue
    snapshots.push(deriveFormSnapshot(page, node))
  }

  return snapshots
}

function deriveFormSnapshot(
  page: Page,
  formNode: PageNode,
): PublishedFormSnapshot {
  const fallbackFormId = normalizeIdentifierValue(formNode.id, 'form')
  const formId = normalizeIdentifierValue(stringProp(formNode, 'formId', formNode.id), fallbackFormId)
  const descendantIds = walkTree(page, formNode.id).filter((nodeId) => nodeId !== formNode.id)
  const controls: FormControlBinding[] = []
  const labels: PublishedFormLabel[] = []
  const submits: PublishedFormSubmit[] = []
  const messages: PublishedFormMessage[] = []

  for (const nodeId of descendantIds) {
    const node = page.nodes[nodeId]
    if (!node) continue

    if (FORM_CONTROL_MODULES.has(node.moduleId)) {
      const control = controlBindingFromNode(node)
      if (control) controls.push(control)
      continue
    }

    if (node.moduleId === 'base.label') {
      const targetNodeId = inferLabelTarget(page, node, formNode.id)
      if (targetNodeId) {
        labels.push({
          nodeId: node.id,
          targetNodeId,
          text: stringProp(node, 'text', ''),
        })
      }
      continue
    }

    if (node.moduleId === 'base.submit') {
      const explicitFormId = normalizeIdentifierValue(stringProp(node, 'formId', ''))
      if (!explicitFormId || explicitFormId === formId) {
        submits.push({
          nodeId: node.id,
          label: stringProp(node, 'label', 'Submit'),
        })
      }
      continue
    }

    if (node.moduleId === 'base.form-message') {
      const explicitFormId = normalizeIdentifierValue(stringProp(node, 'formId', ''))
      if (!explicitFormId || explicitFormId === formId) {
        messages.push({
          nodeId: node.id,
          kind: messageKind(node),
          text: stringProp(node, 'text', ''),
        })
      }
    }
  }

  return {
    pageId: page.id,
    nodeId: formNode.id,
    formId,
    targetTableId: stringProp(formNode, 'targetTableId', ''),
    honeypotName: stringProp(formNode, 'honeypotName', 'company'),
    minSubmitSeconds: numberProp(formNode, 'minSubmitSeconds', 2),
    controls,
    labels,
    submits,
    messages,
  }
}

function controlBindingFromNode(node: PageNode): FormControlBinding | null {
  const fieldId = stringProp(node, 'fieldId', '')
  if (!fieldId) return null
  const name = stringProp(node, 'name', fieldId) || fieldId
  return {
    nodeId: node.id,
    fieldId,
    name,
    ...(node.moduleId === 'base.input' ? { inputType: stringProp(node, 'inputType', 'text') } : {}),
    ...(booleanProp(node, 'required') ? { required: true } : {}),
    ...(positiveNumberProp(node, 'minLength') !== undefined ? { minLength: positiveNumberProp(node, 'minLength') } : {}),
    ...(positiveNumberProp(node, 'maxLength') !== undefined ? { maxLength: positiveNumberProp(node, 'maxLength') } : {}),
    ...(numberPropOrUndefined(node, 'min') !== undefined ? { min: numberPropOrUndefined(node, 'min') } : {}),
    ...(numberPropOrUndefined(node, 'max') !== undefined ? { max: numberPropOrUndefined(node, 'max') } : {}),
    ...(stringProp(node, 'pattern', '') ? { pattern: stringProp(node, 'pattern', '') } : {}),
  }
}

function inferLabelTarget(
  page: Page,
  labelNode: PageNode,
  formNodeId: string,
): string | null {
  const targetMode = stringProp(labelNode, 'targetMode', 'auto')
  const explicit = stringProp(labelNode, 'targetId', '')
  if (targetMode === 'explicit' && explicit) {
    const target = Object.values(page.nodes).find((node) => stringProp(node, 'id', node.id) === explicit || node.id === explicit)
    return target?.id ?? explicit
  }

  const parentId = page.nodes[labelNode.id]?.parentId
  if (!parentId) return null
  const parent = page.nodes[parentId]
  if (!parent) return null
  const labelIndex = parent.children.indexOf(labelNode.id)
  const siblingIds = parent.children.slice(labelIndex + 1)
  for (const siblingId of siblingIds) {
    for (const candidateId of walkTree(page, siblingId)) {
      if (candidateId === formNodeId) continue
      const candidate = page.nodes[candidateId]
      if (candidate && FORM_CONTROL_MODULES.has(candidate.moduleId)) return candidate.id
    }
  }
  return null
}

function walkTree(page: Page, startNodeId: string): string[] {
  const out: string[] = []
  const visit = (nodeId: string) => {
    const node = page.nodes[nodeId]
    if (!node) return
    out.push(nodeId)
    for (const childId of node.children) visit(childId)
  }
  visit(startNodeId)
  return out
}

function stringProp(node: PageNode, key: string, fallback: string): string {
  const value = node.props[key]
  return typeof value === 'string' ? value : fallback
}

function numberProp(node: PageNode, key: string, fallback: number): number {
  const value = node.props[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function numberPropOrUndefined(node: PageNode, key: string): number | undefined {
  const value = node.props[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function positiveNumberProp(node: PageNode, key: string): number | undefined {
  const value = numberPropOrUndefined(node, key)
  return value !== undefined && value > 0 ? value : undefined
}

function booleanProp(node: PageNode, key: string): boolean {
  return node.props[key] === true
}

function messageKind(node: PageNode): PublishedFormMessage['kind'] {
  const kind = stringProp(node, 'kind', 'status')
  return kind === 'success' || kind === 'error' ? kind : 'status'
}
