import { flattenSubtree, getParent, type Page, type PageNode } from '@core/page-tree'
import { normalizeIdentifierValue } from '@core/utils/identifier'
import { PropertyConditionSchema, type PropertyCondition } from '@core/module-engine-schema'
import { compiledCheck } from '@core/utils/typeboxCompiler'
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

  for (const nodeId of flattenSubtree(page, page.rootNodeId)) {
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
  const descendantIds = flattenSubtree(page, formNode.id).filter((nodeId) => nodeId !== formNode.id)
  const controls: FormControlBinding[] = []
  const labels: PublishedFormLabel[] = []
  const submits: PublishedFormSubmit[] = []
  const messages: PublishedFormMessage[] = []

  for (const nodeId of descendantIds) {
    const node = page.nodes[nodeId]
    if (!node) continue

    if (FORM_CONTROL_MODULES.has(node.moduleId)) {
      const control = controlBindingFromNode(node)
      if (control) {
        const conditions: PropertyCondition[] = []
        let parent = getParent(page, node.id)
        while (parent && parent.id !== formNode.id) {
          if (parent.moduleId === 'base.form-conditional' && compiledCheck(PropertyConditionSchema, parent.props.condition)) conditions.push(parent.props.condition)
          parent = getParent(page, parent.id)
        }
        if (conditions.length) control.conditions = conditions
        if (node.moduleId === 'base.select') {
          control.options = flattenSubtree(page, node.id).map((id) => page.nodes[id])
            .filter((entry) => entry?.moduleId === 'base.option' && !entry.props.disabled && !getParent(page, entry.id)?.props.disabled)
            .map((entry) => stringProp(entry, 'value', ''))
        }
        if (node.moduleId === 'base.radio') control.options = [stringProp(node, 'value', 'on')]
      }
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
    ...(node.moduleId === 'base.input' ? { inputType: stringProp(node, 'inputType', 'text') } : node.moduleId === 'base.radio' ? { inputType: 'radio' } : {}),
    ...(booleanProp(node, 'required') ? { required: true } : {}),
    ...(positiveNumberProp(node, 'minLength') !== undefined ? { minLength: positiveNumberProp(node, 'minLength') } : {}),
    ...(positiveNumberProp(node, 'maxLength') !== undefined ? { maxLength: positiveNumberProp(node, 'maxLength') } : {}),
    ...(numberPropOrUndefined(node, 'min') !== undefined ? { min: numberPropOrUndefined(node, 'min') } : {}),
    ...(numberPropOrUndefined(node, 'max') !== undefined ? { max: numberPropOrUndefined(node, 'max') } : {}),
    ...(stringProp(node, 'pattern', '') ? { pattern: stringProp(node, 'pattern', '') } : {}),
    ...(booleanProp(node, 'disabled') ? { disabled: true } : {}),
    ...(compiledCheck(PropertyConditionSchema, node.props.requiredWhen) ? { requiredWhen: node.props.requiredWhen } : {}),
    ...(stringProp(node, 'valueSourceField', '') ? { valueSourceField: stringProp(node, 'valueSourceField', '') } : {}),
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

  const parent = getParent(page, labelNode.id)
  if (!parent) return null
  const labelIndex = parent.children.indexOf(labelNode.id)
  const siblingIds = parent.children.slice(labelIndex + 1)
  for (const siblingId of siblingIds) {
    for (const candidateId of flattenSubtree(page, siblingId)) {
      if (candidateId === formNodeId) continue
      const candidate = page.nodes[candidateId]
      if (candidate && FORM_CONTROL_MODULES.has(candidate.moduleId)) return candidate.id
    }
  }
  return null
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
