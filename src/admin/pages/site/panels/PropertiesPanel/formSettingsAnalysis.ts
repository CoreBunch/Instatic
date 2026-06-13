import type { CreateDataTableInput, DataField, DataTable, DataSelectOption } from '@core/data/schemas'
import type { ImportFragment } from '@core/htmlImport'
import type { Page, PageNode } from '@core/page-tree'
import { createNode } from '@core/page-tree'
import { formDisplayName, humanizeIdentifier, slugifyFormTableName } from './formSettingsNaming'

export { formDisplayName } from './formSettingsNaming'

const FORM_CONTROL_MODULES = new Set([
  'base.input',
  'base.textarea',
  'base.select',
  'base.checkbox',
  'base.radio',
])

const FORM_SETTING_MODULES = new Set([
  'base.form',
  'base.label',
  'base.input',
  'base.textarea',
  'base.select',
  'base.checkbox',
  'base.radio',
  'base.submit',
  'base.form-message',
])

const INPUT_FIELD_TYPES = new Set<DataField['type']>([
  'text',
  'longText',
  'richText',
  'url',
  'email',
  'number',
  'date',
  'dateTime',
])

const TEXTAREA_FIELD_TYPES = new Set<DataField['type']>([
  'text',
  'longText',
  'richText',
])

const SELECT_FIELD_TYPES = new Set<DataField['type']>([
  'select',
  'multiSelect',
])

type FormSettingsKind =
  | 'form'
  | 'control'
  | 'label'
  | 'submit'
  | 'message'
  | 'none'

interface FormSettingsWarning {
  code:
    | 'missing_table'
    | 'missing_field'
    | 'unbound_control'
    | 'duplicate_name'
    | 'outside_form'
    | 'label_without_target'
    | 'submit_without_form'
    | 'incompatible_field'
  message: string
  tone: 'warning' | 'danger'
}

export interface FormContextSummary {
  nodeId: string
  formId: string
  mode: 'cms' | 'custom'
  targetTableId: string
}

interface FormTargetSummary {
  nodeId: string
  label: string
}

export interface FormSettingsAnalysis {
  kind: FormSettingsKind
  node: PageNode | null
  form: FormContextSummary | null
  table: DataTable | null
  field: DataField | null
  compatibleFields: DataField[]
  inferredFields: DataField[]
  missingFields: DataField[]
  inferredTarget: FormTargetSummary | null
  warnings: FormSettingsWarning[]
}

export function isFormSettingsModule(moduleId: string): boolean {
  return FORM_SETTING_MODULES.has(moduleId)
}

export function analyzeFormSettings(input: {
  page: Page | null
  nodeId: string | null
  table?: DataTable | null
}): FormSettingsAnalysis {
  const page = input.page
  const selectedNode = page && input.nodeId ? page.nodes[input.nodeId] ?? null : null
  const table = input.table ?? null
  if (!page || !selectedNode || !isFormSettingsModule(selectedNode.moduleId)) {
    return emptyAnalysis(selectedNode, table)
  }

  const parentByNodeId = buildParentMap(page)
  const formNode = selectedNode.moduleId === 'base.form'
    ? selectedNode
    : nearestAncestorForm(page, selectedNode.id, parentByNodeId)
  const form = formNode ? formSummary(formNode) : null
  const inferredFields = formNode ? inferFieldsFromForm(page, formNode, parentByNodeId) : []
  const missingFields = table && formNode ? fieldsMissingFromForm(page, formNode, table) : []
  const kind = settingsKind(selectedNode.moduleId)
  const warnings: FormSettingsWarning[] = []

  if (form?.mode === 'cms' && !form.targetTableId) {
    warnings.push({
      code: 'missing_table',
      message: 'Choose a target data table before publishing this CMS-native form.',
      tone: 'warning',
    })
  }

  if (kind === 'form' && formNode) {
    warnings.push(...duplicateNameWarnings(page, formNode))
  }

  if (kind === 'control' && !form) {
    warnings.push({
      code: 'outside_form',
      message: 'This control is not inside a form.',
      tone: 'warning',
    })
  }

  const fieldId = stringProp(selectedNode, 'fieldId', '')
  const field = table && fieldId ? table.fields.find((candidate) => candidate.id === fieldId) ?? null : null
  const compatibleFields = table ? table.fields.filter((candidate) => fieldCompatibleWithNode(candidate, selectedNode.moduleId)) : []

  if (kind === 'control' && form?.mode === 'cms' && !fieldId) {
    warnings.push({
      code: 'unbound_control',
      message: 'Bind this control to a table field.',
      tone: 'warning',
    })
  }

  if (kind === 'control' && table && fieldId && !field) {
    warnings.push({
      code: 'missing_field',
      message: `The bound field "${fieldId}" no longer exists in ${table.name}.`,
      tone: 'warning',
    })
  }

  if (kind === 'control' && field && !fieldCompatibleWithNode(field, selectedNode.moduleId)) {
    warnings.push({
      code: 'incompatible_field',
      message: `${field.label} is not compatible with this control type.`,
      tone: 'warning',
    })
  }

  let inferredTarget: FormTargetSummary | null = null
  if (kind === 'label') {
    inferredTarget = inferLabelTarget(page, selectedNode, parentByNodeId)
    if (!inferredTarget) {
      warnings.push({
        code: 'label_without_target',
        message: 'This label has no form control after it.',
        tone: 'warning',
      })
    }
  }

  if (kind === 'submit' && !form) {
    warnings.push({
      code: 'submit_without_form',
      message: 'This submit button is not inside a form.',
      tone: 'warning',
    })
  }

  return {
    kind,
    node: selectedNode,
    form,
    table,
    field,
    compatibleFields,
    inferredFields,
    missingFields,
    inferredTarget,
    warnings,
  }
}

export function buildDataTableDraftFromForm(
  analysis: FormSettingsAnalysis,
  tableNameOverride = '',
): CreateDataTableInput | null {
  if (!analysis.form || analysis.inferredFields.length === 0) return null
  const tableName = tableNameOverride.trim() || suggestDataTableNameFromForm(analysis)
  return {
    name: tableName,
    slug: slugifyFormTableName(tableName),
    kind: 'data',
    singularLabel: 'Submission',
    pluralLabel: 'Submissions',
    primaryFieldId: analysis.inferredFields[0]!.id,
    fields: analysis.inferredFields,
  }
}

export function suggestDataTableNameFromForm(analysis: FormSettingsAnalysis): string {
  const formName = formDisplayName(analysis.form?.formId ?? '')
  return `${formName} submissions`
}

export function formFieldFragmentForDataField(field: DataField): ImportFragment {
  const wrapper = createNode('base.container', { tag: 'div' })
  const label = createNode('base.label', { text: field.label, targetMode: 'auto', targetId: '' })
  const control = createNode(moduleIdForField(field), fieldBindingPatch(field, moduleIdForField(field)))

  wrapper.children.push(label.id, control.id)
  const nodes: Record<string, PageNode> = {
    [wrapper.id]: wrapper,
    [label.id]: label,
    [control.id]: control,
  }

  if ((field.type === 'select' || field.type === 'multiSelect') && 'options' in field) {
    for (const option of field.options) {
      const optionNode = createNode('base.option', {
        label: option.label,
        value: option.value,
        selected: false,
        disabled: false,
      })
      control.children.push(optionNode.id)
      nodes[optionNode.id] = optionNode
    }
  }

  return { nodes, rootIds: [wrapper.id] }
}

export function fieldBindingPatch(field: DataField, moduleId: string): Record<string, unknown> {
  const base = {
    fieldId: field.id,
    name: field.id,
    required: Boolean(field.required),
  }

  switch (moduleId) {
    case 'base.input':
      return {
        ...base,
        id: `${field.id}-input`,
        inputType: inputTypeForField(field),
        ...('maxLength' in field && field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
        ...('min' in field && field.min !== undefined ? { min: String(field.min) } : {}),
        ...('max' in field && field.max !== undefined ? { max: String(field.max) } : {}),
      }
    case 'base.textarea':
      return {
        ...base,
        id: `${field.id}-textarea`,
        ...('maxLength' in field && field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      }
    case 'base.select':
      return {
        ...base,
        id: `${field.id}-select`,
        multiple: field.type === 'multiSelect',
      }
    case 'base.checkbox':
      return {
        ...base,
        id: `${field.id}-checkbox`,
        value: 'on',
      }
    case 'base.radio':
      return {
        ...base,
        id: `${field.id}-radio`,
      }
    default:
      return base
  }
}

function fieldCompatibleWithNode(field: DataField, moduleId: string): boolean {
  switch (moduleId) {
    case 'base.input':
      return INPUT_FIELD_TYPES.has(field.type)
    case 'base.textarea':
      return TEXTAREA_FIELD_TYPES.has(field.type)
    case 'base.select':
      return SELECT_FIELD_TYPES.has(field.type)
    case 'base.checkbox':
      return field.type === 'boolean'
    case 'base.radio':
      return field.type === 'select' || field.type === 'boolean'
    default:
      return false
  }
}

function emptyAnalysis(node: PageNode | null, table: DataTable | null): FormSettingsAnalysis {
  return {
    kind: 'none',
    node,
    form: null,
    table,
    field: null,
    compatibleFields: [],
    inferredFields: [],
    missingFields: [],
    inferredTarget: null,
    warnings: [],
  }
}

function settingsKind(moduleId: string): FormSettingsKind {
  if (moduleId === 'base.form') return 'form'
  if (FORM_CONTROL_MODULES.has(moduleId)) return 'control'
  if (moduleId === 'base.label') return 'label'
  if (moduleId === 'base.submit') return 'submit'
  if (moduleId === 'base.form-message') return 'message'
  return 'none'
}

function formSummary(node: PageNode): FormContextSummary {
  return {
    nodeId: node.id,
    formId: stringProp(node, 'formId', node.id) || node.id,
    mode: stringProp(node, 'mode', 'cms') === 'custom' ? 'custom' : 'cms',
    targetTableId: stringProp(node, 'targetTableId', ''),
  }
}

function duplicateNameWarnings(page: Page, formNode: PageNode): FormSettingsWarning[] {
  const seen = new Map<string, string>()
  const warnings: FormSettingsWarning[] = []
  for (const nodeId of walkTree(page, formNode.id)) {
    if (nodeId === formNode.id) continue
    const node = page.nodes[nodeId]
    if (!node || !FORM_CONTROL_MODULES.has(node.moduleId)) continue
    const name = stringProp(node, 'name', stringProp(node, 'fieldId', ''))
    if (!name) continue
    if (seen.has(name)) {
      warnings.push({
        code: 'duplicate_name',
        message: `Two controls inside this form use the name "${name}".`,
        tone: 'warning',
      })
      continue
    }
    seen.set(name, node.id)
  }
  return warnings
}

function inferFieldsFromForm(
  page: Page,
  formNode: PageNode,
  parentByNodeId: Map<string, string>,
): DataField[] {
  const fields: DataField[] = []
  const usedIds = new Set<string>()
  for (const nodeId of walkTree(page, formNode.id)) {
    if (nodeId === formNode.id) continue
    const node = page.nodes[nodeId]
    if (!node || !FORM_CONTROL_MODULES.has(node.moduleId)) continue
    const field = inferFieldFromControl(page, node, parentByNodeId, usedIds)
    if (field) fields.push(field)
  }
  return fields
}

function inferFieldFromControl(
  page: Page,
  node: PageNode,
  parentByNodeId: Map<string, string>,
  usedIds: Set<string>,
): DataField | null {
  const label = labelForControl(page, node, parentByNodeId)
  const rawId = stringProp(node, 'fieldId', '')
    || stringProp(node, 'name', '')
    || stringProp(node, 'id', '')
    || label
  const id = uniqueFieldId(normalizeFieldId(rawId, node.id), usedIds)
  const required = Boolean(node.props.required)
  const common = {
    id,
    label,
    ...(required ? { required: true } : {}),
  }

  if (node.moduleId === 'base.textarea') {
    return {
      type: 'longText',
      ...common,
    }
  }

  if (node.moduleId === 'base.checkbox') {
    return {
      type: 'boolean',
      ...common,
    }
  }

  if (node.moduleId === 'base.select') {
    return {
      type: node.props.multiple ? 'multiSelect' : 'select',
      ...common,
      options: optionFieldsFromSelect(page, node),
    }
  }

  if (node.moduleId === 'base.radio') {
    const value = stringProp(node, 'value', id)
    return {
      type: 'select',
      ...common,
      options: [{ id: normalizeFieldId(value, 'option'), label: label || value, value }],
    }
  }

  if (node.moduleId !== 'base.input') return null

  const inputType = stringProp(node, 'inputType', 'text')
  if (inputType === 'hidden' || inputType === 'file') return null
  if (inputType === 'email') return { type: 'email', ...common }
  if (inputType === 'url') return { type: 'url', ...common }
  if (inputType === 'number') {
    return {
      type: 'number',
      ...common,
      ...numberProp(node, 'min', 'min'),
      ...numberProp(node, 'max', 'max'),
    }
  }
  if (inputType === 'date') return { type: 'date', ...common }
  if (inputType === 'datetime-local') return { type: 'dateTime', ...common }
  return {
    type: 'text',
    ...common,
    ...positiveNumberProp(node, 'maxLength', 'maxLength'),
  }
}

function fieldsMissingFromForm(page: Page, formNode: PageNode, table: DataTable): DataField[] {
  const representedFieldIds = new Set<string>()
  for (const nodeId of walkTree(page, formNode.id)) {
    if (nodeId === formNode.id) continue
    const node = page.nodes[nodeId]
    if (!node || !FORM_CONTROL_MODULES.has(node.moduleId)) continue
    const representedId = stringProp(node, 'fieldId', '') || stringProp(node, 'name', '')
    if (representedId) representedFieldIds.add(representedId)
  }
  return table.fields.filter((field) => !representedFieldIds.has(field.id) && Boolean(moduleIdForField(field)))
}

function labelForControl(
  page: Page,
  node: PageNode,
  parentByNodeId: Map<string, string>,
): string {
  const parentId = parentByNodeId.get(node.id)
  const parent = parentId ? page.nodes[parentId] : null
  if (parent) {
    const nodeIndex = parent.children.indexOf(node.id)
    for (const siblingId of parent.children.slice(0, nodeIndex).reverse()) {
      const sibling = page.nodes[siblingId]
      if (sibling?.moduleId === 'base.label') {
        const text = stringProp(sibling, 'text', '')
        if (text) return text
      }
    }
  }
  return humanizeIdentifier(controlLabel(node))
}

function optionFieldsFromSelect(page: Page, selectNode: PageNode): DataSelectOption[] {
  const options: DataSelectOption[] = []
  for (const childId of selectNode.children) {
    const child = page.nodes[childId]
    if (!child || child.moduleId !== 'base.option') continue
    const value = stringProp(child, 'value', normalizeFieldId(stringProp(child, 'label', 'option'), 'option'))
    options.push({
      id: normalizeFieldId(value, 'option'),
      label: stringProp(child, 'label', value),
      value,
    })
  }
  return options
}

function inferLabelTarget(
  page: Page,
  labelNode: PageNode,
  parentByNodeId: Map<string, string>,
): FormTargetSummary | null {
  const explicit = stringProp(labelNode, 'targetId', '')
  if (stringProp(labelNode, 'targetMode', 'auto') === 'explicit' && explicit) {
    const explicitNode = Object.values(page.nodes).find((node) => node.id === explicit || stringProp(node, 'id', '') === explicit)
    return explicitNode
      ? { nodeId: explicitNode.id, label: controlLabel(explicitNode) }
      : { nodeId: explicit, label: explicit }
  }

  const parentId = parentByNodeId.get(labelNode.id)
  const parent = parentId ? page.nodes[parentId] : null
  if (!parent) return null
  const labelIndex = parent.children.indexOf(labelNode.id)
  for (const siblingId of parent.children.slice(labelIndex + 1)) {
    for (const candidateId of walkTree(page, siblingId)) {
      const candidate = page.nodes[candidateId]
      if (candidate && FORM_CONTROL_MODULES.has(candidate.moduleId)) {
        return { nodeId: candidate.id, label: controlLabel(candidate) }
      }
    }
  }
  return null
}

function nearestAncestorForm(
  page: Page,
  nodeId: string,
  parentByNodeId: Map<string, string>,
): PageNode | null {
  let currentId = parentByNodeId.get(nodeId)
  while (currentId) {
    const current = page.nodes[currentId]
    if (!current) return null
    if (current.moduleId === 'base.form') return current
    currentId = parentByNodeId.get(current.id)
  }
  return null
}

function buildParentMap(page: Page): Map<string, string> {
  const map = new Map<string, string>()
  for (const node of Object.values(page.nodes)) {
    for (const childId of node.children) map.set(childId, node.id)
  }
  return map
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

function controlLabel(node: PageNode): string {
  return stringProp(node, 'name', stringProp(node, 'fieldId', stringProp(node, 'id', node.id))) || node.id
}

function moduleIdForField(field: DataField): string {
  switch (field.type) {
    case 'longText':
    case 'richText':
      return 'base.textarea'
    case 'select':
    case 'multiSelect':
      return 'base.select'
    case 'boolean':
      return 'base.checkbox'
    default:
      return 'base.input'
  }
}

function inputTypeForField(field: DataField): string {
  switch (field.type) {
    case 'email':
      return 'email'
    case 'url':
      return 'url'
    case 'number':
      return 'number'
    case 'date':
      return 'date'
    case 'dateTime':
      return 'datetime-local'
    default:
      return 'text'
  }
}

function normalizeFieldId(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const value = normalized || fallback
  return /^[0-9]/.test(value) ? `field_${value}` : value
}

function uniqueFieldId(baseId: string, usedIds: Set<string>): string {
  let candidate = baseId
  let suffix = 2
  while (usedIds.has(candidate)) {
    candidate = `${baseId}_${suffix}`
    suffix += 1
  }
  usedIds.add(candidate)
  return candidate
}

function positiveNumberProp<TName extends string>(
  node: PageNode,
  propKey: string,
  outKey: TName,
): Record<TName, number> | Record<string, never> {
  const value = node.props[propKey]
  return typeof value === 'number' && value > 0 ? { [outKey]: value } as Record<TName, number> : {}
}

function numberProp<TName extends string>(
  node: PageNode,
  propKey: string,
  outKey: TName,
): Record<TName, number> | Record<string, never> {
  const value = node.props[propKey]
  if (typeof value === 'number' && Number.isFinite(value)) return { [outKey]: value } as Record<TName, number>
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return { [outKey]: parsed } as Record<TName, number>
  }
  return {}
}
