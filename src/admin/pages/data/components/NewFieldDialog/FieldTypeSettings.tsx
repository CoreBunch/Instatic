import type { Dispatch, SetStateAction } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { ArrowUpIcon } from 'pixel-art-icons/icons/arrow-up'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import type {
  DataFieldType,
  RepeaterItemField,
} from '@core/data/schemas'
import { isRepeaterSummaryField } from '@admin/pages/data/utils/repeaterSummary'
import {
  FIELD_TYPE_OPTIONS,
  MEDIA_KIND_OPTIONS,
  NUMBER_FORMAT_OPTIONS,
  RICH_TEXT_FORMAT_OPTIONS,
  type DraftOption,
} from './newFieldDialogModel'
import styles from './NewFieldDialog.module.css'

interface FieldTypeSettingsProps {
  type: DataFieldType
  textMaxLengthId: string
  textMaxLength: string
  setTextMaxLength: (value: string) => void
  textPlaceholderId: string
  textPlaceholder: string
  setTextPlaceholder: (value: string) => void
  richTextFormat: 'markdown' | 'html'
  setRichTextFormat: (value: 'markdown' | 'html') => void
  numberMinId: string
  numberMin: string
  setNumberMin: (value: string) => void
  numberMaxId: string
  numberMax: string
  setNumberMax: (value: string) => void
  numberStepId: string
  numberStep: string
  setNumberStep: (value: string) => void
  numberInteger: boolean
  setNumberInteger: (value: boolean) => void
  numberFormat: 'number' | 'currency' | 'percent'
  setNumberFormat: (value: 'number' | 'currency' | 'percent') => void
  numberCurrencyId: string
  numberCurrency: string
  setNumberCurrency: (value: string) => void
  booleanDefault: boolean
  setBooleanDefault: (value: boolean) => void
  selectOptions: DraftOption[]
  updateSelectOption: (index: number, patch: Partial<DraftOption>) => void
  removeSelectOption: (index: number) => void
  addSelectOption: () => void
  mediaKind: 'image' | 'video' | 'any'
  setMediaKind: (value: 'image' | 'video' | 'any') => void
  mediaAllowMultiple: boolean
  setMediaAllowMultiple: (value: boolean) => void
  relationTargetTableId: string
  setRelationTargetTableId: (value: string) => void
  relationAllowMultiple: boolean
  setRelationAllowMultiple: (value: boolean) => void
  tableOptions: Array<{ value: string; label: string }>
  clearSubmitError: () => void
  repeaterFields: RepeaterItemField[]
  setRepeaterFields: Dispatch<SetStateAction<RepeaterItemField[]>>
  repeaterItemLabelFieldId: string
  setRepeaterItemLabelFieldId: (value: string) => void
  onAddRepeaterField: () => void
  onEditRepeaterField: (field: RepeaterItemField) => void
}

export function FieldTypeSettings({
  type,
  textMaxLengthId,
  textMaxLength,
  setTextMaxLength,
  textPlaceholderId,
  textPlaceholder,
  setTextPlaceholder,
  richTextFormat,
  setRichTextFormat,
  numberMinId,
  numberMin,
  setNumberMin,
  numberMaxId,
  numberMax,
  setNumberMax,
  numberStepId,
  numberStep,
  setNumberStep,
  numberInteger,
  setNumberInteger,
  numberFormat,
  setNumberFormat,
  numberCurrencyId,
  numberCurrency,
  setNumberCurrency,
  booleanDefault,
  setBooleanDefault,
  selectOptions,
  updateSelectOption,
  removeSelectOption,
  addSelectOption,
  mediaKind,
  setMediaKind,
  mediaAllowMultiple,
  setMediaAllowMultiple,
  relationTargetTableId,
  setRelationTargetTableId,
  relationAllowMultiple,
  setRelationAllowMultiple,
  tableOptions,
  clearSubmitError,
  repeaterFields,
  setRepeaterFields,
  repeaterItemLabelFieldId,
  setRepeaterItemLabelFieldId,
  onAddRepeaterField,
  onEditRepeaterField,
}: FieldTypeSettingsProps) {
  function moveRepeaterField(index: number, offset: -1 | 1) {
    const target = index + offset
    if (target < 0 || target >= repeaterFields.length) return
    setRepeaterFields((current) => {
      const next = [...current]
      const [moved] = next.splice(index, 1)
      if (!moved) return current
      next.splice(target, 0, moved)
      return next
    })
  }

  const summaryFields = repeaterFields.filter(isRepeaterSummaryField)

  return (
    <>
      {type === 'text' && (
        <div className={styles.wideNarrowRow}>
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
          <div className={styles.field}>
            <label htmlFor={textMaxLengthId} className={styles.label}>Max length</label>
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
        </div>
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
          <div className={styles.wideNarrowRow}>
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
            <div className={styles.field}>
              <span className={styles.label}>Integer only</span>
              <div className={styles.switchControl}>
                <Switch checked={numberInteger} onCheckedChange={setNumberInteger} aria-label="Integer only" />
              </div>
            </div>
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
        <div className={styles.field}>
          <span className={styles.label}>Default value</span>
          <div className={styles.switchControl}>
            <Switch checked={booleanDefault} onCheckedChange={setBooleanDefault} aria-label="Default value" />
          </div>
        </div>
      )}

      {(type === 'select' || type === 'multiSelect') && (
        <div className={styles.field}>
          <span className={styles.label}>
            Options <span className={styles.requiredIndicator} aria-hidden="true" title="Required">*</span>
          </span>
          <div className={styles.optionList}>
            {selectOptions.map((option, index) => (
              <div key={option.id} className={styles.optionRow}>
                <Input
                  fieldSize="sm"
                  value={option.label}
                  onChange={(event) => updateSelectOption(index, { label: event.target.value })}
                  placeholder="Label"
                  autoComplete="off"
                />
                <Input
                  fieldSize="sm"
                  value={option.value}
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
          <Button
            variant="secondary"
            size="xs"
            type="button"
            className={styles.compactAction}
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
            <Switch checked={mediaAllowMultiple} onCheckedChange={setMediaAllowMultiple} aria-label="Allow multiple media" />
          </div>
        </>
      )}

      {type === 'relation' && (
        <div className={styles.wideNarrowRow}>
          <div className={styles.field}>
            <span className={styles.label}>
              Target table <span className={styles.requiredIndicator} aria-hidden="true" title="Required">*</span>
            </span>
            {tableOptions.length > 0 ? (
              <Select
                fieldSize="sm"
                value={relationTargetTableId}
                options={tableOptions}
                placeholder="Select a table…"
                onChange={(event) => {
                  setRelationTargetTableId(event.target.value)
                  clearSubmitError()
                }}
              />
            ) : (
              <span className={styles.caption}>No other tables available yet.</span>
            )}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Allow multiple</span>
            <div className={styles.switchControl}>
              <Switch checked={relationAllowMultiple} onCheckedChange={setRelationAllowMultiple} aria-label="Allow multiple relations" />
            </div>
          </div>
        </div>
      )}

      {type === 'repeater' && (
        <div className={styles.repeaterBuilder}>
          <div className={styles.repeaterHeadingRow}>
            <div>
              <span className={styles.label}>
                Item fields <span className={styles.requiredIndicator} aria-hidden="true" title="Required">*</span>
              </span>
              <p className={styles.repeaterHelp}>
                Each repeated item stores this same group of fields. Repeaters cannot be nested.
              </p>
            </div>
            <Button variant="secondary" size="xs" type="button" onClick={onAddRepeaterField}>
              <PlusIcon size={11} aria-hidden="true" />
              Add item field
            </Button>
          </div>

          {repeaterFields.length > 0 ? (
            <div className={styles.repeaterFieldList}>
              {repeaterFields.map((field, index) => (
                <div key={field.id} className={styles.repeaterFieldRow}>
                  <span className={styles.repeaterFieldIndex}>{index + 1}</span>
                  <span className={styles.repeaterFieldName}>
                    <strong>{field.label}</strong>
                    <span>{field.id} · {FIELD_TYPE_OPTIONS.find((option) => option.value === field.type)?.label}</span>
                  </span>
                  <span className={styles.repeaterFieldActions}>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Move ${field.label} up`}
                      tooltip={`Move ${field.label} up`}
                      disabled={index === 0}
                      onClick={() => moveRepeaterField(index, -1)}
                    >
                      <ArrowUpIcon size={11} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Move ${field.label} down`}
                      tooltip={`Move ${field.label} down`}
                      disabled={index === repeaterFields.length - 1}
                      onClick={() => moveRepeaterField(index, 1)}
                    >
                      <ArrowDownIcon size={11} aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="xs" type="button" onClick={() => onEditRepeaterField(field)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Remove ${field.label}`}
                      onClick={() => {
                        setRepeaterFields((current) => current.filter((item) => item.id !== field.id))
                        if (repeaterItemLabelFieldId === field.id) setRepeaterItemLabelFieldId('')
                      }}
                    >
                      <TrashSolidIcon size={12} aria-hidden="true" />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.repeaterEmpty}>
              Add at least one field to describe a repeated item.
            </div>
          )}

          {summaryFields.length > 0 ? (
            <div className={styles.field}>
              <span className={styles.label}>Item summary</span>
              <Select
                fieldSize="sm"
                value={repeaterItemLabelFieldId}
                options={summaryFields.map((field) => ({ value: field.id, label: field.label }))}
                placeholder="Automatic"
                onChange={(event) => setRepeaterItemLabelFieldId(event.target.value)}
              />
              <span className={styles.caption}>
                Used to label collapsed items. Media, relations, and rich text are skipped.
              </span>
            </div>
          ) : repeaterFields.length > 0 ? (
            <div className={styles.field}>
              <span className={styles.label}>Item summary</span>
              <span className={styles.caption}>
                Add a text, number, date, select, URL, or email field to label collapsed items.
              </span>
            </div>
          ) : null}

        </div>
      )}
    </>
  )
}
