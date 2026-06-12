/**
 * ParamRow — three-mode primitive for VC param rows.
 *
 * Modes:
 *   'default-edit'   — editable label (rename), value control, Param chip,
 *                      advanced disclosure, unbind button.
 *   'override-edit'  — read-only label chip, value control, Default/Overridden pill,
 *                      reset button.
 *   'plain'          — read-only label text, value control, no chips.
 *
 * Architecture source: Contribution #619 Phase 2 §A
 * Achromatic palette (Guideline #376). CSS Modules only (Constraint #402/#403).
 */

import { useState } from 'react'
import { validateParamName } from '@core/visualComponents'
import type { VCParamType } from '@core/visualComponents'
import { Input, Textarea } from '@ui/components/Input'
import { Switch } from '@ui/components/Switch'
import { Select } from '@ui/components/Select'
import { ColorInput } from '@ui/components/ColorInput'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { UndoIcon } from 'pixel-art-icons/icons/undo'
import { MediaLibraryControl } from '@site/property-controls/MediaLibraryControl'
import { cn } from '@ui/cn'
import { ControlRow } from '@ui/components/ControlRow'
import styles from './ParamRow.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type ParamRowMode = 'default-edit' | 'override-edit' | 'plain'

interface ParamRowProps {
  mode: ParamRowMode
  /** Free-form param name (uniqueness validated at the slice boundary) */
  paramName: string
  paramType: VCParamType
  /** Stable param id — used for testid and rename self-exclusion */
  paramId?: string
  /** Current value for the right-side control */
  value: unknown
  /** override-edit only — whether this param is overridden on the instance */
  isOverridden?: boolean
  /** Advanced disclosure — required field */
  required?: boolean
  /** Advanced disclosure — description */
  description?: string
  /** When paramType === 'enum' */
  enumOptions?: string[]
  /** Needed by validateParamName when mode === 'default-edit' */
  existingParams?: Array<{ id: string; name: string }>
  onValueChange: (next: unknown) => void
  /** default-edit only */
  onParamRename?: (next: string) => void
  /** default-edit only */
  onUnbind?: () => void
  /** override-edit only */
  onReset?: () => void
  /** default-edit only */
  onAdvancedChange?: (patch: {
    required?: boolean
    description?: string
    enumOptions?: string[]
  }) => void
}

// ---------------------------------------------------------------------------
// ParamRow
// ---------------------------------------------------------------------------

export function ParamRow({
  mode,
  paramName,
  paramType,
  paramId,
  value,
  isOverridden,
  required,
  description,
  enumOptions,
  existingParams,
  onValueChange,
  onParamRename,
  onUnbind,
  onReset,
  onAdvancedChange,
}: ParamRowProps) {
  const [nameDraft, setNameDraft] = useState(paramName)
  const [nameError, setNameError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [newOptionDraft, setNewOptionDraft] = useState('')
  const isDefaultEdit = mode === 'default-edit'

  // "Adjust state during render" pattern (React docs — avoid useEffect for derived state).
  // Track the previous prop values and sync draft state when they change externally.
  const [prevParamName, setPrevParamName] = useState(paramName)
  if (paramName !== prevParamName) {
    setPrevParamName(paramName)
    setNameDraft(paramName)
    setNameError(null)
  }

  // ---------------------------------------------------------------------------
  // Name-editing handlers (default-edit only)
  // ---------------------------------------------------------------------------

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setNameDraft(val)
    const result = validateParamName(val, existingParams ?? [], paramId)
    setNameError(result.ok ? null : result.reason)
  }

  function commitName(val: string) {
    const result = validateParamName(val, existingParams ?? [], paramId)
    if (!result.ok) return
    if (val !== paramName) {
      onParamRename?.(val)
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!nameError) {
        commitName(nameDraft)
        ;(e.target as HTMLInputElement).blur()
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setNameDraft(paramName)
      setNameError(null)
      ;(e.target as HTMLInputElement).blur()
    }
  }

  function handleNameBlur() {
    if (nameError) {
      // Invalid — revert to last known good name
      setNameDraft(paramName)
      setNameError(null)
    } else {
      commitName(nameDraft)
    }
  }

  // ---------------------------------------------------------------------------
  // Enum option add handler
  // ---------------------------------------------------------------------------

  function commitNewOption() {
    const trimmed = newOptionDraft.trim()
    if (!trimmed) return
    if ((enumOptions ?? []).includes(trimmed)) return
    onAdvancedChange?.({ enumOptions: [...(enumOptions ?? []), trimmed] })
    setNewOptionDraft('')
  }

  // ---------------------------------------------------------------------------
  // Type-driven value control
  // ---------------------------------------------------------------------------

  function renderValueControl(inputId?: string): React.ReactNode {
    const strVal = value === null || value === undefined ? '' : String(value)

    switch (paramType) {
      case 'boolean':
        return (
          <Switch
            id={inputId}
            checked={Boolean(value)}
            onCheckedChange={(checked) => onValueChange(checked)}
            switchSize="sm"
          />
        )

      case 'number':
        return (
          <Input
            id={inputId}
            type="number"
            value={strVal}
            onChange={(e) => onValueChange(e.target.valueAsNumber)}
            fieldSize="xs"
          />
        )

      case 'color':
        return (
          <ColorInput
            id={inputId}
            value={strVal || '#000000'}
            onChange={(e) => onValueChange(e.target.value)}
            fieldSize="xs"
          />
        )

      case 'enum':
        return (
          <Select
            id={inputId}
            value={strVal}
            onChange={(e) => onValueChange(e.target.value)}
            fieldSize="xs"
          >
            {(enumOptions ?? []).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </Select>
        )

      case 'image':
        return (
          <MediaLibraryControl
            propKey={`param-${paramId ?? paramName}`}
            label=""
            value={strVal}
            onChange={(_key, val) => onValueChange(val)}
            mediaKind="image"
            layout="stacked"
          />
        )

      case 'richText':
        return <span className={styles.slotCaption}>Use a content outlet</span>

      case 'slot':
        // No value control for slot params — edit on canvas
        return <span className={styles.slotCaption}>Edit on canvas</span>

      case 'string':
      case 'url':
      default:
        return (
          <Input
            id={inputId}
            type={paramType === 'url' ? 'url' : 'text'}
            value={strVal}
            onChange={(e) => onValueChange(e.target.value)}
            fieldSize="xs"
          />
        )
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const paramKey = paramId ?? paramName
  const nameInputId = `param-name-${paramKey}`
  const valueInputId = `param-value-${paramKey}`

  return (
    <div
      data-testid="param-row"
      data-mode={mode}
      className={cn(styles.rowWrapper, isDefaultEdit && styles.rowWrapperDefault)}
    >
      {isDefaultEdit ? (
        <>
          <div className={styles.defaultHeader}>
            <div className={styles.badgeGroup}>
              <span className={styles.paramBadge}>Param</span>
              <span className={styles.typeChip}>{paramType}</span>
            </div>
            <div className={styles.defaultActions}>
              <Button
                variant="ghost"
                size="micro"
                iconOnly
                aria-label={advancedOpen ? 'Close advanced options' : 'Open advanced options'}
                tooltip={advancedOpen ? 'Close advanced options' : 'Open advanced options'}
                onClick={() => setAdvancedOpen((o) => !o)}
              >
                {advancedOpen ? (
                  <ChevronUpIcon size={10} color="currentColor" aria-hidden="true" />
                ) : (
                  <ChevronDownIcon size={10} color="currentColor" aria-hidden="true" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="micro"
                iconOnly
                aria-label="Unbind param"
                tooltip="Stop exposing this property"
                onClick={() => onUnbind?.()}
              >
                <CloseIcon size={10} color="currentColor" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className={styles.defaultFields}>
            <ControlRow
              propKey={`param-name-${paramKey}`}
              label="Param name"
              inputId={nameInputId}
            >
              <Input
                id={nameInputId}
                fieldSize="xs"
                value={nameDraft}
                onChange={handleNameChange}
                onBlur={handleNameBlur}
                onKeyDown={handleNameKeyDown}
                aria-label="Parameter name"
                invalid={!!nameError}
                className={styles.nameInput}
              />
            </ControlRow>

            <ControlRow
              propKey={`param-value-${paramKey}`}
              label="Default value"
              inputId={valueInputId}
            >
              {renderValueControl(valueInputId)}
            </ControlRow>
          </div>
        </>
      ) : (
        <div className={styles.row}>
          {/* Label slot */}
          <div className={styles.labelSlot}>
            {mode === 'override-edit' && (
              <span className={styles.paramNameChip} title={paramName}>
                {paramName}
              </span>
            )}
            {mode === 'plain' && (
              <span className={styles.paramLabel} title={paramName}>
                {paramName}
              </span>
            )}
          </div>

          {/* Value slot */}
          <div className={styles.valueSlot}>
            {renderValueControl()}
          </div>

          {/* Chip / action slot */}
          <div className={styles.chipSlot}>
            {mode === 'override-edit' && (
              <>
                <span className={styles.overridePill}>
                  {isOverridden ? 'Overridden' : 'Default'}
                </span>
                {isOverridden && (
                  <Button
                    variant="ghost"
                    size="micro"
                    iconOnly
                    aria-label={`Reset ${paramName} to default`}
                    tooltip="Reset to default"
                    onClick={() => onReset?.()}
                  >
                    <UndoIcon size={10} color="currentColor" aria-hidden="true" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Name validation error ────────────────────────────────────────── */}
      {nameError && (
        <div role="alert" className={styles.nameError}>
          {nameError}
        </div>
      )}

      {/* ── Advanced disclosure (default-edit only) ──────────────────────── */}
      {isDefaultEdit && advancedOpen && (
        <div className={styles.advanced}>
          <div className={styles.advancedRow}>
            <span className={styles.advancedLabel}>Required</span>
            <Switch
              checked={required ?? false}
              onCheckedChange={(checked) => onAdvancedChange?.({ required: checked })}
              switchSize="sm"
            />
          </div>

          <div className={styles.advancedRow}>
            <span className={styles.advancedLabel}>Description</span>
            <Textarea
              fieldSize="xs"
              rows={2}
              value={description ?? ''}
              onChange={(e) => onAdvancedChange?.({ description: e.target.value })}
            />
          </div>

          {paramType === 'enum' && (
            <div className={styles.advancedRow}>
              <span className={styles.advancedLabel}>Options</span>
              <div className={styles.enumOptions}>
                <div className={styles.chipList}>
                  {(enumOptions ?? []).map((opt, idx) => (
                    <span key={idx} className={styles.chip}>
                      <span className={styles.chipText}>{opt}</span>
                      <Button
                        variant="ghost"
                        size="micro"
                        iconOnly
                        aria-label={`Remove option ${opt}`}
                        onClick={() =>
                          onAdvancedChange?.({
                            enumOptions: (enumOptions ?? []).filter((_, i) => i !== idx),
                          })
                        }
                      >
                        <CloseIcon size={8} color="currentColor" aria-hidden="true" />
                      </Button>
                    </span>
                  ))}
                </div>
                <Input
                  fieldSize="xs"
                  value={newOptionDraft}
                  placeholder="Add option…"
                  onChange={(e) => setNewOptionDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitNewOption()
                    }
                  }}
                  onBlur={commitNewOption}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
