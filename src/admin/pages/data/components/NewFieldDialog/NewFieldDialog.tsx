import { useId, useState, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { DataFieldSchema, type DataField, type DataFieldType, type DataSelectOption, type DataTable } from '@core/data/schemas'
import { buildPostTypeDefaultFields } from '@core/data/fields'
import { safeParseValue, formatValueErrors } from '@core/utils/typeboxHelpers'
import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import styles from './NewFieldDialog.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  FIELD_TYPE_OPTIONS,
  MEDIA_KIND_OPTIONS,
  NUMBER_FORMAT_OPTIONS,
  RICH_TEXT_FORMAT_OPTIONS,
  fieldIdError,
  makeOption,
  slugifyOptionValue,
  type DraftOption,
} from './newFieldDialogModel'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStepUpCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === StepUpCancelledMessage
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

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
  onCreate: (field: DataField) => Promise<void>
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewFieldDialog({
  open,
  onClose,
  existingFieldIds,
  tables,
  missingOptionalBuiltInIds,
  onCreate,
}: NewFieldDialogProps) {
  // Common fields
  const [type, setType] = useState<DataFieldType>('text')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [label, setLabel] = useState('')
  const [required, setRequired] = useState(false)
  const [description, setDescription] = useState('')

  // text-specific
  const [textMaxLength, setTextMaxLength] = useState('')
  const [textPlaceholder, setTextPlaceholder] = useState('')

  // richText-specific
  const [richTextFormat, setRichTextFormat] = useState<'markdown' | 'html'>('markdown')

  // number-specific
  const [numberMin, setNumberMin] = useState('')
  const [numberMax, setNumberMax] = useState('')
  const [numberStep, setNumberStep] = useState('')
  const [numberInteger, setNumberInteger] = useState(false)
  const [numberFormat, setNumberFormat] = useState<'number' | 'currency' | 'percent'>('number')
  const [numberCurrency, setNumberCurrency] = useState('')

  // boolean-specific
  const [booleanDefault, setBooleanDefault] = useState(false)

  // select/multiSelect
  const [selectOptions, setSelectOptions] = useState<DraftOption[]>([makeOption('')])

  // media-specific
  const [mediaKind, setMediaKind] = useState<'image' | 'video' | 'any'>('any')
  const [mediaAllowMultiple, setMediaAllowMultiple] = useState(false)

  // relation-specific
  const [relationTargetTableId, setRelationTargetTableId] = useState('')
  const [relationAllowMultiple, setRelationAllowMultiple] = useState(false)

  // Submit state
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Form field ids — pair labels with their controls via htmlFor.
  const idInputId = useId()
  const labelInputId = useId()
  const descriptionInputId = useId()
  const textMaxLengthId = useId()
  const textPlaceholderId = useId()
  const numberMinId = useId()
  const numberMaxId = useId()
  const numberStepId = useId()
  const numberCurrencyId = useId()

  const trimmedId = id.trim()
  const trimmedLabel = label.trim()
  const idErr = idTouched ? fieldIdError(trimmedId, existingFieldIds) : null
  const needsSelectOption = (type === 'select' || type === 'multiSelect') && selectOptions.every((o) => !o.label.trim())

  const needsRelationTarget = type === 'relation' && !relationTargetTableId

  const canCreate = Boolean(
    trimmedId &&
    trimmedLabel &&
    !fieldIdError(trimmedId, existingFieldIds) &&
    !needsSelectOption &&
    !needsRelationTarget &&
    !saving,
  )

  function resetForm() {
    setType('text')
    setId('')
    setIdTouched(false)
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
    if (!canCreate) return

    // Build common props
    const common = {
      id: trimmedId,
      label: trimmedLabel,
      ...(required ? { required: true } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
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
      setSubmitError(getErrorMessage(err, 'Could not create field').replace(/^\[[^\]]+\]\s*/, ''))
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
      setSubmitError(getErrorMessage(err, 'Could not add field').replace(/^\[[^\]]+\]\s*/, ''))
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="New field"
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form="new-field-dialog-form"
            disabled={!canCreate}
          >
            {saving ? 'Creating…' : 'Create'}
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

      <form id="new-field-dialog-form" className={styles.form} onSubmit={handleSubmit}>
        {/* Type */}
        <div className={styles.field}>
          <span className={styles.label}>Type</span>
          <Select
            fieldSize="sm"
            value={type}
            options={[...FIELD_TYPE_OPTIONS]}
            onChange={(event) => {
              setType(event.target.value as DataFieldType)
              setSubmitError(null)
            }}
          />
        </div>

        {/* ID */}
        <div className={styles.field}>
          <label htmlFor={idInputId} className={styles.label}>ID</label>
          <Input
            id={idInputId}
            fieldSize="sm"
            value={id}
            invalid={Boolean(idErr)}
            onChange={(event) => {
              setIdTouched(true)
              setId(event.target.value)
              setSubmitError(null)
            }}
            onBlur={() => setIdTouched(true)}
            placeholder="product_name"
            autoComplete="off"
            spellCheck={false}
            monospace
          />
          {idErr && (
            <span className={styles.fieldError} role="alert">{idErr}</span>
          )}
          {!idErr && (
            <span className={styles.caption}>Machine name: lowercase letters, numbers, underscores.</span>
          )}
        </div>

        {/* Label */}
        <div className={styles.field}>
          <label htmlFor={labelInputId} className={styles.label}>Label</label>
          <Input
            id={labelInputId}
            fieldSize="sm"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value)
              setSubmitError(null)
            }}
            placeholder="Product name"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Required */}
        <div className={styles.switchRow}>
          <span className={styles.switchLabel}>Required</span>
          <Switch checked={required} onCheckedChange={setRequired} />
        </div>

        {/* Description */}
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

        {/* ── Type-specific fields ── */}

        {type === 'text' && (
          <>
            <div className={styles.field}>
              <label htmlFor={textMaxLengthId} className={styles.label}>Max length <span className={styles.optional}>(optional)</span></label>
              <Input
                id={textMaxLengthId}
                fieldSize="sm"
                type="number"
                value={textMaxLength}
                onChange={(event) => setTextMaxLength(event.target.value)}
                placeholder="255"
                min={1}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor={textPlaceholderId} className={styles.label}>Placeholder <span className={styles.optional}>(optional)</span></label>
              <Input
                id={textPlaceholderId}
                fieldSize="sm"
                value={textPlaceholder}
                onChange={(event) => setTextPlaceholder(event.target.value)}
                placeholder="Enter a value…"
              />
            </div>
          </>
        )}

        {type === 'richText' && (
          <div className={styles.field}>
            <span className={styles.label}>Format</span>
            <Select
              fieldSize="sm"
              value={richTextFormat}
              options={RICH_TEXT_FORMAT_OPTIONS}
              onChange={(event) => setRichTextFormat(event.target.value as 'markdown' | 'html')}
            />
          </div>
        )}

        {type === 'number' && (
          <>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label htmlFor={numberMinId} className={styles.label}>Min <span className={styles.optional}>(optional)</span></label>
                <Input id={numberMinId} fieldSize="sm" type="number" value={numberMin} onChange={(event) => setNumberMin(event.target.value)} />
              </div>
              <div className={styles.field}>
                <label htmlFor={numberMaxId} className={styles.label}>Max <span className={styles.optional}>(optional)</span></label>
                <Input id={numberMaxId} fieldSize="sm" type="number" value={numberMax} onChange={(event) => setNumberMax(event.target.value)} />
              </div>
              <div className={styles.field}>
                <label htmlFor={numberStepId} className={styles.label}>Step <span className={styles.optional}>(optional)</span></label>
                <Input id={numberStepId} fieldSize="sm" type="number" value={numberStep} onChange={(event) => setNumberStep(event.target.value)} />
              </div>
            </div>
            <div className={styles.switchRow}>
              <span className={styles.switchLabel}>Integer only</span>
              <Switch checked={numberInteger} onCheckedChange={setNumberInteger} />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Format</span>
              <Select
                fieldSize="sm"
                value={numberFormat}
                options={NUMBER_FORMAT_OPTIONS}
                onChange={(event) => setNumberFormat(event.target.value as 'number' | 'currency' | 'percent')}
              />
            </div>
            {numberFormat === 'currency' && (
              <div className={styles.field}>
                <label htmlFor={numberCurrencyId} className={styles.label}>Currency code <span className={styles.optional}>(e.g. USD)</span></label>
                <Input
                  id={numberCurrencyId}
                  fieldSize="sm"
                  value={numberCurrency}
                  onChange={(event) => setNumberCurrency(event.target.value)}
                  placeholder="USD"
                  maxLength={10}
                />
              </div>
            )}
          </>
        )}

        {type === 'boolean' && (
          <div className={styles.switchRow}>
            <span className={styles.switchLabel}>Default value</span>
            <Switch checked={booleanDefault} onCheckedChange={setBooleanDefault} />
          </div>
        )}

        {(type === 'select' || type === 'multiSelect') && (
          <div className={styles.field}>
            <span className={styles.label}>Options</span>
            <div className={styles.optionList}>
              {selectOptions.map((opt, index) => (
                <div key={opt.id} className={styles.optionRow}>
                  <Input
                    fieldSize="sm"
                    value={opt.label}
                    onChange={(event) => updateSelectOption(index, { label: event.target.value })}
                    placeholder="Label"
                    autoComplete="off"
                  />
                  <Input
                    fieldSize="sm"
                    value={opt.value}
                    onChange={(event) => updateSelectOption(index, { value: event.target.value })}
                    placeholder="value"
                    autoComplete="off"
                    monospace
                  />
                  <Button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    type="button"
                    aria-label="Remove option"
                    onClick={() => removeSelectOption(index)}
                    disabled={selectOptions.length <= 1}
                  >
                    <TrashSolidIcon size={12} aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
            {needsSelectOption && (
              <span className={styles.fieldError} role="alert">At least one option is required.</span>
            )}
            <Button
              variant="ghost"
              size="xs"
              type="button"
              align="start"
              onClick={addSelectOption}
            >
              <PlusIcon size={11} aria-hidden="true" />
              Add option
            </Button>
          </div>
        )}

        {type === 'media' && (
          <>
            <div className={styles.field}>
              <span className={styles.label}>Media kind</span>
              <Select
                fieldSize="sm"
                value={mediaKind}
                options={MEDIA_KIND_OPTIONS}
                onChange={(event) => setMediaKind(event.target.value as 'image' | 'video' | 'any')}
              />
            </div>
            <div className={styles.switchRow}>
              <span className={styles.switchLabel}>Allow multiple</span>
              <Switch checked={mediaAllowMultiple} onCheckedChange={setMediaAllowMultiple} />
            </div>
          </>
        )}

        {type === 'relation' && (
          <>
            <div className={styles.field}>
              <span className={styles.label}>Target table</span>
              {tableOptions.length > 0 ? (
                <Select
                  fieldSize="sm"
                  value={relationTargetTableId}
                  options={tableOptions}
                  placeholder="Select a table…"
                  onChange={(event) => {
                    setRelationTargetTableId(event.target.value)
                    setSubmitError(null)
                  }}
                />
              ) : (
                <span className={styles.caption}>No other tables available yet.</span>
              )}
              {needsRelationTarget && tableOptions.length > 0 && (
                <span className={styles.fieldError} role="alert">A target table is required.</span>
              )}
            </div>
            <div className={styles.switchRow}>
              <span className={styles.switchLabel}>Allow multiple</span>
              <Switch checked={relationAllowMultiple} onCheckedChange={setRelationAllowMultiple} />
            </div>
          </>
        )}

        {submitError && (
          <p role="alert" className={styles.errorText}>
            {submitError}
          </p>
        )}
      </form>
    </Dialog>
  )
}
