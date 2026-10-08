import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { DataField, DataTable, DataTableListItem } from '@core/data/schemas'
import { isFormSubmissionTargetTable } from '@core/forms'
import type { Page } from '@core/page-tree'
import { getErrorMessage } from '@core/utils/errorMessage'
import { normalizeIdentifierInput, normalizeIdentifierValue } from '@core/utils/identifier'
import { createCmsDataTable, getCmsDataTable, listCmsDataTables } from '@core/persistence/cmsData'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { useEditorStore } from '@site/store/store'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Select } from '@ui/components/Select'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import {
  analyzeFormSettings,
  buildDataTableDraftFromForm,
  fieldBindingPatch,
  formDisplayName,
  formFieldFragmentForDataField,
  suggestDataTableNameFromForm,
  type FormContextSummary,
  type FormSettingsAnalysis,
} from './formSettingsAnalysis'
import styles from './FormSettingsPanel.module.css'

type FormPreviewState = 'default' | 'submitting' | 'success' | 'error'
type FormMode = FormContextSummary['mode']
type FormTableOption = Pick<DataTable, 'id' | 'name' | 'kind' | 'system'>

const FORM_MODE_OPTIONS: ReadonlyArray<{ value: FormMode; label: string }> = [
  { value: 'cms', label: 'CMS-native' },
  { value: 'custom', label: 'HTML action' },
  { value: 'request', label: 'HTTP request' },
]

const FORM_PREVIEW_STATES: ReadonlyArray<{ value: FormPreviewState; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'submitting', label: 'Submitting' },
  { value: 'success', label: 'Success' },
  { value: 'error', label: 'Error' },
]

interface FormSettingsPanelProps {
  page: Page | null
  nodeId: string | null
  onPatchProps: (patch: Record<string, unknown>) => void
}

interface FormSettingsPanelViewProps {
  analysis: FormSettingsAnalysis
  tables: FormTableOption[]
  tablesLoading: boolean
  tablesError: string
  previewState: FormPreviewState
  loading: boolean
  error: string
  onPatchProps: (patch: Record<string, unknown>) => void
  onTargetTableChange: (tableId: string) => void
  onCreateTable: (tableName: string) => void | Promise<void>
  onInsertMissingField: (field: DataField) => void
  onPreviewStateChange: (state: FormPreviewState) => void
}

export function FormSettingsPanel({
  page,
  nodeId,
  onPatchProps,
}: FormSettingsPanelProps) {
  const preliminary = analyzeFormSettings({ page, nodeId })
  const targetTableId = preliminary.form?.mode === 'cms' ? preliminary.form.targetTableId : ''
  const insertImportedNodes = useEditorStore((s) => s.insertImportedNodes)
  const selectNode = useEditorStore((s) => s.selectNode)
  const { runStepUp } = useStepUp()
  const previewState = useEditorStore((s) => {
    const formNodeId = preliminary.form?.nodeId
    return formNodeId ? s.formPreviewStates[formNodeId] ?? 'default' : 'default'
  })
  const setFormPreviewState = useEditorStore((s) => s.setFormPreviewState)
  const [actionError, setActionError] = useState('')
  const creatingTableRef = useRef(false)
  const tablesResource = useAsyncResource<DataTableListItem[]>(
    () => listCmsDataTables(),
    [],
    { fallbackError: 'Failed to load data tables.' },
  )
  const tableResource = useAsyncResource<DataTable | null>(
    () => targetTableId ? getCmsDataTable(targetTableId) : Promise.resolve(null),
    [targetTableId],
    { fallbackError: 'Failed to load target data table.' },
  )
  const table = targetTableId && tableResource.data?.id === targetTableId
    ? tableResource.data
    : null

  const analysis = analyzeFormSettings({ page, nodeId, table })

  async function handleCreateTable(tableName: string) {
    const draft = buildDataTableDraftFromForm(analysis, tableName)
    if (!draft) return
    creatingTableRef.current = true
    setActionError('')
    try {
      const created = await runStepUp(() => createCmsDataTable(draft))
      onPatchProps({ targetTableId: created.id })
      tablesResource.refresh()
      tableResource.refresh()
      creatingTableRef.current = false
    } catch (err) {
      creatingTableRef.current = false
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      const message = getErrorMessage(err, 'Failed to create target data table.')
      setActionError(message)
      throw new Error(message, { cause: err })
    }
  }

  function handleInsertMissingField(field: DataField) {
    if (!page || !analysis.form) return
    const formNode = page.nodes[analysis.form.nodeId]
    if (!formNode) return
    const fragment = formFieldFragmentForDataField(field)
    const inserted = insertImportedNodes(
      formNode.id,
      fragment,
      { index: fieldInsertIndex(page, formNode.id) },
    )
    if (inserted[0]) selectNode(inserted[0])
  }

  return (
    <FormSettingsPanelView
      analysis={analysis}
      tables={tablesResource.data ?? []}
      tablesLoading={tablesResource.loading}
      tablesError={tablesResource.error ?? ''}
      previewState={previewState}
      loading={Boolean(targetTableId && tableResource.loading)}
      error={actionError || (targetTableId ? tableResource.error ?? '' : '')}
      onPatchProps={onPatchProps}
      onTargetTableChange={(nextTableId) => onPatchProps({ targetTableId: nextTableId })}
      onCreateTable={(tableName) => {
        if (creatingTableRef.current) return undefined
        return handleCreateTable(tableName)
      }}
      onInsertMissingField={handleInsertMissingField}
      onPreviewStateChange={(state) => {
        if (!analysis.form) return
        setFormPreviewState(analysis.form.nodeId, state)
      }}
    />
  )
}

export function FormSettingsPanelView({
  analysis,
  tables,
  tablesLoading,
  tablesError,
  previewState,
  loading,
  error,
  onPatchProps,
  onTargetTableChange,
  onCreateTable,
  onInsertMissingField,
  onPreviewStateChange,
}: FormSettingsPanelViewProps) {
  if (analysis.kind === 'none') return null

  const title = panelTitle(analysis)
  const relationship = relationshipText(analysis)
  const showMeta = analysis.kind !== 'form'

  return (
    <div className={styles.formSettingsPanel} data-testid="form-settings-panel">
      <div className={styles.header}>
        <span className={styles.kicker}>{kicker(analysis.kind)}</span>
        <span className={styles.title}>{title}</span>
      </div>

      {analysis.kind === 'form' && analysis.form && (
        <FormIdentityRows
          form={analysis.form}
          onPatchProps={onPatchProps}
        />
      )}

      {showMeta && (
        <div className={styles.meta}>
          {analysis.form && (
            <span className={styles.metaItem}>{formDisplayName(analysis.form.formId)}</span>
          )}
          {analysis.table && (
            <span className={styles.metaItem}>{analysis.table.name}</span>
          )}
          {analysis.field && (
            <span className={styles.metaItem}>{analysis.field.label}</span>
          )}
        </div>
      )}

      {loading && (
        <output className={styles.inlineStatus}>
          Loading target table
        </output>
      )}

      {tablesError && (
        <div className={cn(styles.warning, styles.danger)} role="alert">
          {tablesError}
        </div>
      )}

      {error && (
        <div className={cn(styles.warning, styles.danger)} role="alert">
          {error}
        </div>
      )}

      {analysis.kind === 'form' && analysis.form && (
        <>
          <PreviewStateRow
            value={previewState}
            onChange={onPreviewStateChange}
          />

          {analysis.form.mode === 'cms' && (
            <FormTargetTableRow
              analysis={analysis}
              tables={tables}
              loading={tablesLoading}
              onTargetTableChange={onTargetTableChange}
              onCreateTable={onCreateTable}
            />
          )}

          {analysis.table && analysis.missingFields.length > 0 && (
            <MissingFieldsRow
              fields={analysis.missingFields}
              onInsertMissingField={onInsertMissingField}
            />
          )}
        </>
      )}

      {analysis.kind === 'control' && analysis.table && (
        <FieldBindingRow
          analysis={analysis}
          onPatchProps={onPatchProps}
        />
      )}

      {relationship && (
        <div className={styles.relationship}>{relationship}</div>
      )}

      {analysis.warnings.length > 0 && (
        <div className={styles.warnings}>
          {analysis.warnings.map((warning) => (
            <div
              key={`${warning.code}:${warning.message}`}
              className={cn(styles.warning, warning.tone === 'danger' && styles.danger)}
              role={warning.tone === 'danger' ? 'alert' : 'status'}
            >
              {warning.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FormIdentityRows({
  form,
  onPatchProps,
}: {
  form: FormContextSummary
  onPatchProps: (patch: Record<string, unknown>) => void
}) {
  const formIdInputId = useId()

  return (
    <div className={styles.primaryControls}>
      <ControlRow
        propKey="form-mode"
        label="Mode"
        layout="stacked"
      >
        <SegmentedControl
          value={form.mode}
          options={FORM_MODE_OPTIONS}
          onChange={(mode) => onPatchProps({ mode })}
          size="xs"
          fullWidth
          aria-label="Form mode"
          data-testid="form-mode"
        />
      </ControlRow>
      <ControlRow
        propKey="form-id"
        inputId={formIdInputId}
        label="Form ID"
        layout="stacked"
      >
        <Input
          id={formIdInputId}
          fieldSize="sm"
          value={form.formId}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onPatchProps({ formId: normalizeIdentifierInput(event.target.value) })}
          onBlur={(event) => onPatchProps({ formId: normalizeIdentifierValue(event.target.value, 'form') })}
        />
      </ControlRow>
    </div>
  )
}

function PreviewStateRow({
  value,
  onChange,
}: {
  value: FormPreviewState
  onChange: (state: FormPreviewState) => void
}) {
  return (
    <ControlRow
      propKey="form-preview-state"
      label="Preview state"
      layout="stacked"
    >
      <SegmentedControl
        value={value}
        options={FORM_PREVIEW_STATES}
        onChange={onChange}
        size="xs"
        fullWidth
        aria-label="Preview state"
        data-testid="form-preview-state"
      />
    </ControlRow>
  )
}

function FormTargetTableRow({
  analysis,
  tables,
  loading,
  onTargetTableChange,
  onCreateTable,
}: {
  analysis: FormSettingsAnalysis
  tables: FormTableOption[]
  loading: boolean
  onTargetTableChange: (tableId: string) => void
  onCreateTable: (tableName: string) => void | Promise<void>
}) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const targetTableId = analysis.form?.targetTableId ?? ''
  const options = [{ label: 'Choose table', value: '' }]
  for (const table of tables) {
    if (!isFormSubmissionTargetTable(table)) continue
    options.push({ label: table.name, value: table.id })
  }
  const canCreateTable = analysis.inferredFields.length > 0

  function handleTableChange(event: ChangeEvent<HTMLSelectElement>) {
    onTargetTableChange(event.target.value)
  }

  return (
    <div className={styles.section}>
      <ControlRow
        propKey="form-target-table"
        inputId="form-target-table"
        label="Target table"
        layout="stacked"
      >
        <div className={styles.targetTableControl} data-testid="form-target-table-control">
          <Select
            id="form-target-table"
            name="form-target-table"
            fieldSize="sm"
            value={targetTableId}
            options={options}
            placeholder="Choose table"
            disabled={loading}
            onChange={handleTableChange}
          />
          <Button
            className={styles.createTableButton}
            variant="secondary"
            size="sm"
            iconOnly
            aria-label="Create table"
            tooltip="Create table"
            disabled={!canCreateTable}
            type="button"
            onClick={() => setCreateDialogOpen(true)}
          >
            <PlusIcon size={14} />
          </Button>
        </div>
      </ControlRow>
      {!canCreateTable && (
        <div className={styles.inlineStatus}>
          Add named form fields before creating a CMS data table.
        </div>
      )}
      {createDialogOpen && (
        <CreateFormTableDialog
          defaultName={suggestDataTableNameFromForm(analysis)}
          onClose={() => setCreateDialogOpen(false)}
          onCreate={onCreateTable}
        />
      )}
    </div>
  )
}

function CreateFormTableDialog({
  defaultName,
  onClose,
  onCreate,
}: {
  defaultName: string
  onClose: () => void
  onCreate: (tableName: string) => void | Promise<void>
}) {
  const [name, setName] = useState(defaultName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmedName = name.trim()

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedName || saving) return
    setSaving(true)
    setError('')
    try {
      await onCreate(trimmedName)
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create target data table.'))
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create target table"
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form="form-table-create"
            disabled={!trimmedName || saving}
          >
            {saving ? 'Creating...' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="form-table-create" className={styles.createTableForm} onSubmit={handleSubmit}>
        <div className={styles.dialogField}>
          <label htmlFor={inputId} className={styles.dialogLabel}>Table name</label>
          <Input
            id={inputId}
            ref={inputRef}
            fieldSize="sm"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError('')
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <span className={styles.inlineStatus}>
            Fields will be inferred from the controls in this form.
          </span>
        </div>
        {error && (
          <p className={styles.dialogError} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

function MissingFieldsRow({
  fields,
  onInsertMissingField,
}: {
  fields: DataField[]
  onInsertMissingField: (field: DataField) => void
}) {
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel}>Missing fields</span>
      <div className={styles.missingFieldList}>
        {fields.map((field) => (
          <div key={field.id} className={styles.missingFieldRow}>
            <span className={styles.missingFieldName}>{field.label}</span>
            <span className={styles.missingFieldType}>{field.type}</span>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Add ${field.label} field`}
              onClick={() => onInsertMissingField(field)}
            >
              <PlusIcon size={13} />
              Add
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function FieldBindingRow({
  analysis,
  onPatchProps,
}: {
  analysis: FormSettingsAnalysis
  onPatchProps: (patch: Record<string, unknown>) => void
}) {
  const value = analysis.field?.id ?? ''
  const options = [
    { label: 'Choose field', value: '' },
    ...analysis.compatibleFields.map((field) => ({
      label: `${field.label} (${field.type})`,
      value: field.id,
    })),
  ]

  function handleFieldChange(event: ChangeEvent<HTMLSelectElement>) {
    const field = analysis.compatibleFields.find((candidate) => candidate.id === event.target.value)
    if (!field || !analysis.node) return
    onPatchProps(fieldBindingPatch(field, analysis.node.moduleId))
  }

  return (
    <div className={styles.fieldRow}>
      <ControlRow
        propKey="form-field-binding"
        inputId="form-field-binding"
        label="Field"
        layout="stacked"
      >
        <Select
          id="form-field-binding"
          name="form-field-binding"
          fieldSize="sm"
          value={value}
          options={options}
          placeholder="Choose field"
          onChange={handleFieldChange}
        />
      </ControlRow>
      {analysis.compatibleFields.length === 0 && (
        <div className={styles.inlineStatus}>
          No compatible fields in the target table.
        </div>
      )}
    </div>
  )
}

function kicker(kind: FormSettingsAnalysis['kind']): string {
  switch (kind) {
    case 'form':
      return 'Form setup'
    case 'control':
      return 'Field binding'
    case 'label':
      return 'Label target'
    case 'submit':
      return 'Submit target'
    case 'message':
      return 'Message target'
    case 'none':
      return ''
  }
}

function panelTitle(analysis: FormSettingsAnalysis): string {
  if (analysis.kind === 'form') {
    return analysis.form?.mode === 'custom' ? 'HTML action form' : analysis.form?.mode === 'request' ? 'HTTP request form' : 'CMS-native form'
  }
  if (analysis.kind === 'control') {
    return analysis.field ? analysis.field.label : 'Unbound control'
  }
  if (analysis.kind === 'label') return 'Label'
  if (analysis.kind === 'submit') return 'Submit button'
  if (analysis.kind === 'message') return 'Form message'
  return ''
}

function relationshipText(analysis: FormSettingsAnalysis): string {
  if (analysis.kind === 'label' && analysis.inferredTarget) {
    return `Targets ${analysis.inferredTarget.label}.`
  }
  if ((analysis.kind === 'submit' || analysis.kind === 'message') && analysis.form) {
    return `Connected to ${analysis.form.formId}.`
  }
  if (analysis.kind === 'control' && analysis.form) {
    return `Inside ${analysis.form.formId}.`
  }
  return ''
}

function fieldInsertIndex(page: Page, formNodeId: string): number {
  const formNode = page.nodes[formNodeId]
  if (!formNode) return 0
  const actionIndex = formNode.children.findIndex((childId) => {
    const child = page.nodes[childId]
    return child?.moduleId === 'base.form-message' || child?.moduleId === 'base.submit'
  })
  return actionIndex === -1 ? formNode.children.length : actionIndex
}
