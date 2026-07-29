import { useId, useState, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import {
  DataFieldSchema,
  RepeaterItemFieldSchema,
  type DataField,
  type DataFieldType,
  type DataSelectOption,
  type DataTable,
  type RepeaterItemField,
} from '@core/data/schemas'
import { buildPostTypeDefaultFields } from '@core/data/fields'
import { safeParseValue, formatValueErrors } from '@core/utils/typeboxHelpers'
import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import styles from './NewFieldDialog.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  FIELD_TYPE_OPTIONS,
  fieldIdFromLabel,
  fieldIdError,
  makeOption,
  slugifyOptionValue,
  type DraftOption,
} from './newFieldDialogModel'
import { FieldTypeSettings } from './FieldTypeSettings'

function isStepUpCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === StepUpCancelledMessage
}

interface NewFieldDialogProps {
  open: boolean
  onClose: () => void
  existingFieldIds: string[]
  tables: DataTable[]
  /**
   * Optional built-in field IDs that are missing from a postType table.
   * When provided, a "Re-add built-in fields" section appears at the top
   * of the dialog with quick-add buttons — clicking one inserts the
   * canonical built-in field shape without needing to fill the form.
   */
  missingOptionalBuiltInIds?: readonly string[]
  /** Repeater sub-fields pass false to enforce the non-recursive v1 model. */
  allowRepeater?: boolean
  /** Existing field to edit. Its type and machine id stay stable. */
  initialField?: DataField
  /** Built-in fields keep their author-facing label stable. */
  lockLabel?: boolean
  onCreate: (field: DataField) => Promise<void>
}

export function NewFieldDialog({
  open,
  onClose,
  existingFieldIds,
  tables,
  missingOptionalBuiltInIds,
  allowRepeater = true,
  initialField,
  lockLabel = false,
  onCreate,
}: NewFieldDialogProps) {
  const [type, setType] = useState<DataFieldType>(initialField?.type ?? 'text')
  const [id, setId] = useState(initialField?.id ?? '')
  const [idManuallyEdited, setIdManuallyEdited] = useState(false)
  const [label, setLabel] = useState(initialField?.label ?? '')
  const [required, setRequired] = useState(initialField?.required ?? false)
  const [description, setDescription] = useState(initialField?.description ?? '')

  const [textMaxLength, setTextMaxLength] = useState(
    initialField?.type === 'text' ? (initialField.maxLength?.toString() ?? '') : '',
  )
  const [textPlaceholder, setTextPlaceholder] = useState(
    initialField?.type === 'text' ? (initialField.placeholder ?? '') : '',
  )

  const [richTextFormat, setRichTextFormat] = useState<'markdown' | 'html'>(
    initialField?.type === 'richText' ? initialField.format : 'markdown',
  )

  const [numberMin, setNumberMin] = useState(
    initialField?.type === 'number' ? (initialField.min?.toString() ?? '') : '',
  )
  const [numberMax, setNumberMax] = useState(
    initialField?.type === 'number' ? (initialField.max?.toString() ?? '') : '',
  )
  const [numberStep, setNumberStep] = useState(
    initialField?.type === 'number' ? (initialField.step?.toString() ?? '') : '',
  )
  const [numberInteger, setNumberInteger] = useState(
    initialField?.type === 'number' ? (initialField.integer ?? false) : false,
  )
  const [numberFormat, setNumberFormat] = useState<'number' | 'currency' | 'percent'>(
    initialField?.type === 'number' ? (initialField.format ?? 'number') : 'number',
  )
  const [numberCurrency, setNumberCurrency] = useState(
    initialField?.type === 'number' ? (initialField.currency ?? '') : '',
  )

  const [booleanDefault, setBooleanDefault] = useState(
    initialField?.type === 'boolean' ? (initialField.defaultValue ?? false) : false,
  )

  const [selectOptions, setSelectOptions] = useState<DraftOption[]>(
    initialField?.type === 'select' || initialField?.type === 'multiSelect'
      ? initialField.options.map((option) => ({ ...option }))
      : [makeOption('')],
  )

  const [mediaKind, setMediaKind] = useState<'image' | 'video' | 'any'>(
    initialField?.type === 'media' ? (initialField.mediaKind ?? 'any') : 'any',
  )
  const [mediaAllowMultiple, setMediaAllowMultiple] = useState(
    initialField?.type === 'media' ? (initialField.allowMultiple ?? false) : false,
  )

  const [relationTargetTableId, setRelationTargetTableId] = useState(
    initialField?.type === 'relation' ? initialField.targetTableId : '',
  )
  const [relationAllowMultiple, setRelationAllowMultiple] = useState(
    initialField?.type === 'relation' ? (initialField.allowMultiple ?? false) : false,
  )

  const [repeaterFields, setRepeaterFields] = useState<RepeaterItemField[]>(
    initialField?.type === 'repeater' ? initialField.fields : [],
  )
  const [repeaterItemLabelFieldId, setRepeaterItemLabelFieldId] = useState(
    initialField?.type === 'repeater' ? (initialField.itemLabelFieldId ?? '') : '',
  )
  const [nestedFieldDialogOpen, setNestedFieldDialogOpen] = useState(false)
  const [editingNestedField, setEditingNestedField] = useState<RepeaterItemField | null>(null)

  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const idInputId = useId()
  const labelInputId = useId()
  const typeSelectId = useId()
  const descriptionInputId = useId()
  const textMaxLengthId = useId()
  const textPlaceholderId = useId()
  const numberMinId = useId()
  const numberMaxId = useId()
  const numberStepId = useId()
  const numberCurrencyId = useId()
  const formId = useId()

  const trimmedId = id.trim()
  const trimmedLabel = label.trim()
  const idErr = trimmedId ? fieldIdError(trimmedId, existingFieldIds) : null
  const needsSelectOption = (type === 'select' || type === 'multiSelect') && selectOptions.every((o) => !o.label.trim())

  const needsRelationTarget = type === 'relation' && !relationTargetTableId
  const needsRepeaterField = type === 'repeater' && repeaterFields.length === 0

  const canCreate = Boolean(
    trimmedId &&
    trimmedLabel &&
    !fieldIdError(trimmedId, existingFieldIds) &&
    !needsSelectOption &&
    !needsRelationTarget &&
    !needsRepeaterField &&
    !saving,
  )

  function resetForm() {
    setType('text')
    setId('')
    setIdManuallyEdited(false)
    setLabel('')
    setRequired(false)
    setDescription('')
    setTextMaxLength('')
    setTextPlaceholder('')
    setRichTextFormat('markdown')
    setNumberMin('')
    setNumberMax('')
    setNumberStep('')
    setNumberInteger(false)
    setNumberFormat('number')
    setNumberCurrency('')
    setBooleanDefault(false)
    setSelectOptions([makeOption('')])
    setMediaKind('any')
    setMediaAllowMultiple(false)
    setRelationTargetTableId('')
    setRelationAllowMultiple(false)
    setRepeaterFields([])
    setRepeaterItemLabelFieldId('')
    setNestedFieldDialogOpen(false)
    setEditingNestedField(null)
    setSaving(false)
    setSubmitError(null)
  }

  function handleClose() {
    resetForm()
    onClose()
  }

  function updateSelectOption(index: number, patch: Partial<DraftOption>) {
    setSelectOptions((prev) =>
      prev.map((opt, i) => {
        if (i !== index) return opt
        const next = { ...opt, ...patch }
        // Auto-derive value from label unless value was manually set
        if ('label' in patch && !('value' in patch)) {
          next.value = slugifyOptionValue(next.label)
        }
        return next
      }),
    )
  }

  function removeSelectOption(index: number) {
    setSelectOptions((prev) => prev.filter((_, i) => i !== index))
  }

  function addSelectOption() {
    setSelectOptions((prev) => [...prev, makeOption('')])
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    // This dialog can be portalled from inside the New Table form. React
    // events follow the component tree across portals, so stop the nested
    // submit before it reaches and prematurely submits the table form.
    event.stopPropagation()
    if (!canCreate) return

    // Build common props
    const common = {
      id: trimmedId,
      label: trimmedLabel,
      ...(required ? { required: true } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(initialField?.builtIn ? { builtIn: true } : {}),
    }

    // Build type-specific field object
    let fieldShape: unknown

    switch (type) {
      case 'text': {
        fieldShape = {
          type: 'text',
          ...common,
          ...(textMaxLength ? { maxLength: Number(textMaxLength) } : {}),
          ...(textPlaceholder.trim() ? { placeholder: textPlaceholder.trim() } : {}),
        }
        break
      }
      case 'longText': {
        fieldShape = { type: 'longText', ...common }
        break
      }
      case 'richText': {
        fieldShape = { type: 'richText', ...common, format: richTextFormat }
        break
      }
      case 'number': {
        fieldShape = {
          type: 'number',
          ...common,
          ...(numberMin !== '' ? { min: Number(numberMin) } : {}),
          ...(numberMax !== '' ? { max: Number(numberMax) } : {}),
          ...(numberStep !== '' ? { step: Number(numberStep) } : {}),
          ...(numberInteger ? { integer: true } : {}),
          ...(numberFormat !== 'number' ? { format: numberFormat } : {}),
          ...(numberFormat === 'currency' && numberCurrency.trim() ? { currency: numberCurrency.trim() } : {}),
        }
        break
      }
      case 'boolean': {
        fieldShape = {
          type: 'boolean',
          ...common,
          ...(booleanDefault ? { defaultValue: true } : {}),
        }
        break
      }
      case 'date': {
        fieldShape = { type: 'date', ...common }
        break
      }
      case 'dateTime': {
        fieldShape = { type: 'dateTime', ...common }
        break
      }
      case 'select': {
        const options: DataSelectOption[] = selectOptions
          .filter((o) => o.label.trim())
          .map((o) => ({ id: o.id, label: o.label.trim(), value: o.value || slugifyOptionValue(o.label) }))
        fieldShape = { type: 'select', ...common, options }
        break
      }
      case 'multiSelect': {
        const options: DataSelectOption[] = selectOptions
          .filter((o) => o.label.trim())
          .map((o) => ({ id: o.id, label: o.label.trim(), value: o.value || slugifyOptionValue(o.label) }))
        fieldShape = { type: 'multiSelect', ...common, options }
        break
      }
      case 'url': {
        fieldShape = { type: 'url', ...common }
        break
      }
      case 'email': {
        fieldShape = { type: 'email', ...common }
        break
      }
      case 'media': {
        fieldShape = {
          type: 'media',
          ...common,
          ...(mediaKind !== 'any' ? { mediaKind } : {}),
          ...(mediaAllowMultiple ? { allowMultiple: true } : {}),
        }
        break
      }
      case 'relation': {
        fieldShape = {
          type: 'relation',
          ...common,
          targetTableId: relationTargetTableId,
          ...(relationAllowMultiple ? { allowMultiple: true } : {}),
        }
        break
      }
      case 'repeater': {
        fieldShape = {
          type: 'repeater',
          ...common,
          fields: repeaterFields,
          ...(repeaterItemLabelFieldId ? { itemLabelFieldId: repeaterItemLabelFieldId } : {}),
        }
        break
      }
      case 'pageTree':
      case 'fieldSchema': {
        // Structural fields are internal and never offered by this dialog.
        break
      }
    }

    // Validate against DataFieldSchema
    const result = safeParseValue(DataFieldSchema, fieldShape)
    if (!result.ok) {
      setSubmitError(formatValueErrors(DataFieldSchema, fieldShape))
      return
    }

    setSaving(true)
    setSubmitError(null)
    try {
      await onCreate(result.value)
      resetForm()
    } catch (err) {
      if (isStepUpCancelled(err)) {
        setSaving(false)
        return
      }
      const message = getErrorMessage(
        err,
        initialField ? 'Could not save field' : 'Could not create field',
      ).replace(/^\[[^\]]+\]\s*/, '')
      console.error('[NewFieldDialog] Field save failed:', err)
      pushToast({
        kind: 'error',
        title: initialField ? 'Field update failed' : 'Field creation failed',
        body: message,
        location: 'data-workspace',
      })
      setSaving(false)
    }
  }

  const tableOptions = tables.map((t) => ({ value: t.id, label: t.name }))

  // Compute quick-add built-in shapes from the canonical default field set.
  const builtInDefaults = buildPostTypeDefaultFields()
  const quickAddFields = (missingOptionalBuiltInIds ?? [])
    .map((id) => builtInDefaults.find((f) => f.id === id))
    .filter((f): f is DataField => f !== undefined)

  async function handleQuickAddBuiltIn(field: DataField) {
    setSaving(true)
    setSubmitError(null)
    try {
      await onCreate(field)
      handleClose()
    } catch (err) {
      if (isStepUpCancelled(err)) {
        setSaving(false)
        return
      }
      const message = getErrorMessage(err, 'Could not add field').replace(/^\[[^\]]+\]\s*/, '')
      console.error('[NewFieldDialog] Built-in field add failed:', err)
      pushToast({
        kind: 'error',
        title: 'Field creation failed',
        body: message,
        location: 'data-workspace',
      })
      setSaving(false)
    }
  }

  const hasTypeSettings = [
    'text',
    'richText',
    'number',
    'boolean',
    'select',
    'multiSelect',
    'media',
    'relation',
    'repeater',
  ].includes(type)

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={initialField ? `Edit ${initialField.label}` : 'New field'}
      size={type === 'repeater' ? 'xl' : 'md'}
      className={styles.dialog}
      closeOnEscape={!nestedFieldDialogOpen}
      closeOnBackdrop={!nestedFieldDialogOpen}
      footer={
        <>
          <Button variant="ghost" size="sm" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={formId}
            disabled={!canCreate}
          >
            {saving ? 'Saving…' : initialField ? 'Save field' : 'Create field'}
          </Button>
        </>
      }
    >
      {/* Quick-add section for missing optional built-ins (postType tables only) */}
      {quickAddFields.length > 0 && (
        <div className={styles.builtInSection}>
          <span className={styles.builtInHeading}>Re-add built-in fields</span>
          <div className={styles.builtInList}>
            {quickAddFields.map((field) => (
              <Button
                key={field.id}
                variant="secondary"
                size="sm"
                type="button"
                disabled={saving}
                onClick={() => void handleQuickAddBuiltIn(field)}
              >
                <PlusIcon size={11} aria-hidden="true" />
                {field.label}
              </Button>
            ))}
          </div>
          <div className={styles.builtInDivider} />
        </div>
      )}

      <form id={formId} className={styles.form} onSubmit={handleSubmit}>
        <section className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <h3>Field identity</h3>
            <p>Name the value authors will see and the stable key used by templates.</p>
          </div>

          <div className={styles.field}>
            <label htmlFor={labelInputId} className={styles.label}>
              Label <span className={styles.requiredIndicator} aria-hidden="true" title="Required">*</span>
            </label>
            <Input
              id={labelInputId}
              fieldSize="sm"
              value={label}
              disabled={lockLabel}
              onChange={(event) => {
                const nextLabel = event.target.value
                setLabel(nextLabel)
                if (!initialField && !idManuallyEdited) {
                  setId(fieldIdFromLabel(nextLabel))
                }
                setSubmitError(null)
              }}
              placeholder="Product name"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className={styles.identityRow}>
            <div className={styles.field}>
              <label htmlFor={idInputId} className={styles.label}>
                ID <span className={styles.requiredIndicator} aria-hidden="true" title="Required">*</span>
              </label>
              <Input
                id={idInputId}
                fieldSize="sm"
                value={id}
                invalid={Boolean(idErr)}
                onChange={(event) => {
                  setIdManuallyEdited(true)
                  setId(event.target.value)
                  setSubmitError(null)
                }}
                placeholder="product_name"
                autoComplete="off"
                spellCheck={false}
                monospace
                disabled={Boolean(initialField)}
              />
              {idErr && (
                <span className={styles.fieldError} role="alert">{idErr}</span>
              )}
              {!idErr && (
                <span className={styles.caption}>
                  {initialField
                    ? 'ID is fixed after creation.'
                    : 'Generated from the label. You can change it.'}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <label htmlFor={typeSelectId} className={styles.label}>
                Type <span className={styles.requiredIndicator} aria-hidden="true" title="Required">*</span>
              </label>
              <Select
                id={typeSelectId}
                fieldSize="sm"
                value={type}
                options={FIELD_TYPE_OPTIONS.filter((option) => allowRepeater || option.value !== 'repeater')}
                disabled={Boolean(initialField)}
                onChange={(event) => {
                  setType(event.target.value as DataFieldType)
                  setSubmitError(null)
                }}
              />
              <span className={styles.caption}>
                {initialField ? 'Type is fixed after creation.' : 'Controls the value and authoring UI.'}
              </span>
            </div>
          </div>
        </section>

        <section className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <h3>Authoring</h3>
            <p>Set the expectations and guidance shown when someone edits a record.</p>
          </div>

          <div className={styles.wideNarrowRow}>
            <div className={styles.field}>
              <label htmlFor={descriptionInputId} className={styles.label}>Description <span className={styles.optional}>(optional)</span></label>
              <Textarea
                id={descriptionInputId}
                fieldSize="sm"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Shown next to the field in the editor"
                rows={2}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Required</span>
              <div className={styles.switchControl}>
                <Switch
                  checked={required}
                  onCheckedChange={setRequired}
                  aria-label="Required"
                />
              </div>
            </div>
          </div>
        </section>

        {hasTypeSettings && (
          <section className={`${styles.formSection} ${styles.typeSettingsSection}`}>
            <div className={styles.sectionHeading}>
              <h3>{type === 'repeater' ? 'Item structure' : 'Field behavior'}</h3>
              <p>
                {type === 'repeater'
                  ? 'Build the reusable group of values stored inside every item.'
                  : 'Configure how this field accepts and presents values.'}
              </p>
            </div>

            <FieldTypeSettings
              type={type}
              textMaxLengthId={textMaxLengthId}
              textMaxLength={textMaxLength}
              setTextMaxLength={setTextMaxLength}
              textPlaceholderId={textPlaceholderId}
              textPlaceholder={textPlaceholder}
              setTextPlaceholder={setTextPlaceholder}
              richTextFormat={richTextFormat}
              setRichTextFormat={setRichTextFormat}
              numberMinId={numberMinId}
              numberMin={numberMin}
              setNumberMin={setNumberMin}
              numberMaxId={numberMaxId}
              numberMax={numberMax}
              setNumberMax={setNumberMax}
              numberStepId={numberStepId}
              numberStep={numberStep}
              setNumberStep={setNumberStep}
              numberInteger={numberInteger}
              setNumberInteger={setNumberInteger}
              numberFormat={numberFormat}
              setNumberFormat={setNumberFormat}
              numberCurrencyId={numberCurrencyId}
              numberCurrency={numberCurrency}
              setNumberCurrency={setNumberCurrency}
              booleanDefault={booleanDefault}
              setBooleanDefault={setBooleanDefault}
              selectOptions={selectOptions}
              updateSelectOption={updateSelectOption}
              removeSelectOption={removeSelectOption}
              addSelectOption={addSelectOption}
              mediaKind={mediaKind}
              setMediaKind={setMediaKind}
              mediaAllowMultiple={mediaAllowMultiple}
              setMediaAllowMultiple={setMediaAllowMultiple}
              relationTargetTableId={relationTargetTableId}
              setRelationTargetTableId={setRelationTargetTableId}
              relationAllowMultiple={relationAllowMultiple}
              setRelationAllowMultiple={setRelationAllowMultiple}
              tableOptions={tableOptions}
              clearSubmitError={() => setSubmitError(null)}
              repeaterFields={repeaterFields}
              setRepeaterFields={setRepeaterFields}
              repeaterItemLabelFieldId={repeaterItemLabelFieldId}
              setRepeaterItemLabelFieldId={setRepeaterItemLabelFieldId}
              onAddRepeaterField={() => setNestedFieldDialogOpen(true)}
              onEditRepeaterField={(field) => {
                setEditingNestedField(field)
                setNestedFieldDialogOpen(true)
              }}
            />
          </section>
        )}

        {submitError && (
          <p role="alert" className={styles.errorText}>
            {submitError}
          </p>
        )}
      </form>

      {nestedFieldDialogOpen && (
        <NewFieldDialog
          open
          onClose={() => {
            setNestedFieldDialogOpen(false)
            setEditingNestedField(null)
          }}
          existingFieldIds={repeaterFields
            .filter((field) => field.id !== editingNestedField?.id)
            .map((field) => field.id)}
          tables={tables}
          allowRepeater={false}
          initialField={editingNestedField ?? undefined}
          onCreate={async (field) => {
            const result = safeParseValue(RepeaterItemFieldSchema, field)
            if (!result.ok) {
              throw new Error('This field type cannot be used inside a repeater.')
            }
            setRepeaterFields((current) => editingNestedField
              ? current.map((item) => item.id === editingNestedField.id ? result.value : item)
              : [...current, result.value],
            )
            setNestedFieldDialogOpen(false)
            setEditingNestedField(null)
          }}
        />
      )}
    </Dialog>
  )
}
