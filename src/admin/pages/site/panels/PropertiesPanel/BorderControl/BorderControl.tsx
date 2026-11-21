/** Edits per-side border longhands and the outline of the current style target. */
import { useEffect, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { NumericStyleInput } from '@site/property-controls/NumericStyleInput'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import { BORDER_STYLE_KEYWORDS } from '../cssControlTypes'
import styles from './BorderControl.module.css'

import { SIDES, borderKey, type Side, type BorderField } from './borderSides'

interface BorderControlProps {
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /**
   * Patch-shaped hover-preview channel (see StyleRuleComposer.handlePreview).
   * Forwarded to the border-style select and border-colour field so hovering
   * a suggestion previews on the canvas; honours the current link state so a
   * linked border previews all four sides at once.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

// ---------------------------------------------------------------------------
// Value readers
// ---------------------------------------------------------------------------

function pickString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return `${value}px`
  return ''
}

/** Read every side's value for one field; report whether all four match. */
function readSideField(
  styles: Record<string, unknown>,
  field: BorderField,
): { perSide: Record<Side, string>; uniform: boolean; anySet: boolean } {
  const perSide = {} as Record<Side, string>
  for (const side of SIDES) perSide[side] = pickString(styles[borderKey(side, field)])
  const values = SIDES.map((s) => perSide[s])
  const anySet = values.some((v) => v !== '')
  const uniform = values.every((v) => v === values[0])
  return { perSide, uniform, anySet }
}

// ---------------------------------------------------------------------------
// BorderControl
// ---------------------------------------------------------------------------

export function BorderControl({
  storedStyles,
  currentStyles,
  onChange,
  onChangeMany,
  onPreview,
  onClearPreview,
}: BorderControlProps) {
  // Hover previews are gated by the shared "Preview suggestions on hover"
  // preference. The border-colour field self-gates (ColorValueInput reads the
  // pref); the raw style <Select> below is gated here.
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')

  useEffect(() => {
    if (!hoverPreviewEnabled) onClearPreview?.()
  }, [hoverPreviewEnabled, onClearPreview])
  // ── Border (per-side) state ──────────────────────────────────────────────
  const widthState = readSideField(storedStyles, 'Width')
  const styleState = readSideField(storedStyles, 'Style')
  const colorState = readSideField(storedStyles, 'Color')

  const widthFallback = readSideField(currentStyles, 'Width')

  // All three fields uniform across all sides → the border is "linked".
  const borderUniform = widthState.uniform && styleState.uniform && colorState.uniform
  const borderAnySet = widthState.anySet || styleState.anySet || colorState.anySet

  const [borderLinked, setBorderLinked] = useState(borderUniform)

  const [activeSide, setActiveSide] = useState<Side>('Top')

  // The side whose values populate the inputs: 'Top' when linked, else the
  // user-selected side.
  const editSide: Side = borderLinked ? 'Top' : activeSide

  const sidePatch = (field: BorderField, value: string | number | undefined) => {
    const sides = borderLinked ? SIDES : [editSide]
    return Object.fromEntries(sides.map((side) => [borderKey(side, field), value ?? null]))
  }
  const writeSide = (field: BorderField, value: string | number | undefined) =>
    onChangeMany(sidePatch(field, value))
  const previewSide = hoverPreviewEnabled && onPreview
    ? (field: BorderField, value: string | number | undefined) => onPreview(sidePatch(field, value))
    : undefined

  const clearBorder = () => {
    onChangeMany(Object.fromEntries(SIDES.flatMap((side) =>
      (['Width', 'Style', 'Color'] as const).map((field) => [borderKey(side, field), undefined]))))
  }

  const widthValue = widthState.perSide[editSide]
  const styleValue = styleState.perSide[editSide]
  const colorValue = colorState.perSide[editSide]

  const widthPlaceholder = widthFallback.perSide[editSide] || '0px'

  return (
    <div className={styles.root}>
      {/* ── Border ──────────────────────────────────────────────────────── */}
      <div className={styles.group}>
        <div className={styles.groupHeader}>
          <span className={styles.groupTitle}>Sides</span>
          <div className={styles.groupActions}>
            <Button
              variant="ghost"
              size="micro"
              iconOnly
              active={borderLinked}
              aria-label={borderLinked ? 'Unlink sides' : 'Link all sides'}
              tooltip={borderLinked ? 'Editing all sides' : 'Editing one side'}
              onClick={() => setBorderLinked((v) => !v)}
            >
              <LinkIcon size={14} aria-hidden="true" />
            </Button>
            {borderAnySet && (
              <Button
                variant="ghost"
                size="micro"
                iconOnly
                aria-label="Clear border"
                tooltip="Clear border"
                onClick={clearBorder}
              >
                <CloseIcon size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        <div className={styles.borderBody}>
          <SidePicker
            linked={borderLinked}
            activeSide={activeSide}
            setSides={widthState.perSide}
            onSelectSide={(side) => {
              setBorderLinked(false)
              setActiveSide(side)
            }}
          />

          <div className={styles.fields}>
            <FieldRow label="Width">
              <NumericStyleInput defaultUnit="px" min={0} onScrubPreview={(v) => onPreview?.(sidePatch('Width', v))} onClearPreview={onClearPreview}
                onAdjust={(value) => writeSide('Width', value)}
                fieldSize="sm"
                value={widthValue}
                placeholder={widthPlaceholder}
                aria-label={`Border ${borderLinked ? 'all sides' : editSide.toLowerCase()} width`}
                onChange={(e) => writeSide('Width', e.target.value || undefined)}
              />
            </FieldRow>

            <FieldRow label="Style">
              <Select
                fieldSize="sm"
                value={styleValue}
                aria-label={`Border ${borderLinked ? 'all sides' : editSide.toLowerCase()} style`}
                onChange={(e) => writeSide('Style', e.target.value || undefined)}
                options={[
                  { label: '—', value: '' },
                  ...BORDER_STYLE_KEYWORDS.map((o) => ({ label: o, value: o })),
                ]}
                onOptionPreview={previewSide ? (v) => previewSide('Style', v || undefined) : undefined}
                onOptionPreviewClear={previewSide ? onClearPreview : undefined}
              />
            </FieldRow>

            <FieldRow label="Color">
              <ColorValueInput richPicker
                id={`border-${editSide}-color`}
                value={colorValue}
                ariaLabel={`Border ${borderLinked ? 'all sides' : editSide.toLowerCase()} color`}
                swatchLabel={`Border ${borderLinked ? 'all sides' : editSide.toLowerCase()} color swatch`}
                onChange={(v) => writeSide('Color', v || undefined)}
                onPreview={onPreview ? (v) => previewSide?.('Color', v || undefined) : undefined}
                onClearPreview={onClearPreview}
              />
            </FieldRow>
          </div>
        </div>
      </div>

      {/* ── Outline (single shorthand row pair) ─────────────────────────── */}
      <div className={styles.outlineRows}>
        <FieldRow label="Outline">
          <Input
            fieldSize="sm"
            value={pickString(storedStyles.outline)}
            placeholder={pickString(currentStyles.outline) || 'none'}
            aria-label="Outline"
            onChange={(e) => onChange('outline', e.target.value || undefined)}
          />
        </FieldRow>
        <FieldRow label="Offset">
          <NumericStyleInput defaultUnit="px" onScrubPreview={(v) => onPreview?.({ outlineOffset: v })} onClearPreview={onClearPreview}
            onAdjust={(value) => onChange('outlineOffset', value)}
            fieldSize="sm"
            value={pickString(storedStyles.outlineOffset)}
            placeholder={pickString(currentStyles.outlineOffset) || '0px'}
            aria-label="Outline offset"
            onChange={(e) => onChange('outlineOffset', e.target.value || undefined)}
          />
        </FieldRow>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FieldRow — label column + control, matching ControlRow's inline anatomy
// ---------------------------------------------------------------------------

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldControl}>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SidePicker — clickable 4-edge box
// ---------------------------------------------------------------------------

interface SidePickerProps {
  linked: boolean
  activeSide: Side
  setSides: Record<Side, string>
  onSelectSide: (side: Side) => void
}

function SidePicker({ linked, activeSide, setSides, onSelectSide }: SidePickerProps) {
  return (
    <div className={styles.sidePicker} role="group" aria-label="Border side">
      <div className={styles.sideBox}>
        {SIDES.map((side) => {
          const isActive = linked || side === activeSide
          const hasValue = setSides[side] !== ''
          return (
            <button
              key={side}
              type="button"
              className={cn(
                styles.sideEdge,
                styles[`side${side}`],
                isActive && styles.sideEdgeActive,
                hasValue && styles.sideEdgeSet,
              )}
              aria-label={`Edit ${side.toLowerCase()} border`}
              aria-pressed={isActive}
              onClick={() => onSelectSide(side)}
            />
          )
        })}
        <span className={styles.sideBoxCore} aria-hidden="true" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CornerPicker — clickable 4-corner box
// ---------------------------------------------------------------------------
