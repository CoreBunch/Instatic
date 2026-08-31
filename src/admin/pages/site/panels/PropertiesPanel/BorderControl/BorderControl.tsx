/**
 * BorderControl — the prototype's Border editor.
 *
 *   ┌─────────────────────────────┐
 *   │   ╔═══════════════════╗     │  edge box: click an edge to edit it alone
 *   │   ╚═══════════════════╝     │
 *   ├─────────────────────────────┤
 *   │  Editing all sides       ⛓  │  scope chip (mirrors the Width scope pair)
 *   │  Color  [ ■ 222222       ]  │
 *   │  Width  [ 1    ] [ ▣ | ⊞ ]  │
 *   │  Style  [ Solid         ▾]  │
 *   └─────────────────────────────┘
 *
 * Storage model — the per-side longhands are the canonical shape:
 *   borderTopWidth / borderTopStyle / borderTopColor (× right / bottom / left)
 *
 * The CSS shorthands (`border`, `borderTop`, …) are not the control's source
 * of truth — they live in the section's "Advanced" rows for power users who
 * want to paste a raw shorthand string. Per-corner RADIUS is not part of this
 * control: it is the Styles section's own Radius row.
 *
 * Link/sync semantics match SpacingBoxControl: while linked, a write applies
 * to all four sides; unlinked, the user picks an active edge in the box and
 * edits it alone. The control auto-relinks when external changes bring all
 * sides back to a uniform value (React-19 render-time idiom, no effect).
 */

import { useEffect, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { AllSidesGlyph, PerSideGlyph, RemoveXGlyph } from '@ui/icons/inspectorGlyphs'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { cn } from '@ui/cn'
import { getEnumOptions } from '../cssControlTypes'
import styles from './BorderControl.module.css'

// ---------------------------------------------------------------------------
// Types + key helpers
// ---------------------------------------------------------------------------

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
type Side = (typeof SIDES)[number]

type BorderField = 'Width' | 'Style' | 'Color'

type BorderScope = 'all' | 'side'

function borderKey(side: Side, field: BorderField): keyof CSSPropertyBag {
  return `border${side}${field}` as keyof CSSPropertyBag
}

interface BorderControlProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /**
   * Fully clear a property across base + all breakpoints. Border edits use
   * this (not the lighter `onRemove`) so a "Clear border" affordance really
   * removes the longhands everywhere, matching the LayoutSection / Position
   * clear semantics.
   */
  onClearProperty: (property: keyof CSSPropertyBag) => void
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
  const uniform = anySet && values.every((v) => v === values[0])
  return { perSide, uniform, anySet }
}

// ---------------------------------------------------------------------------
// BorderControl
// ---------------------------------------------------------------------------

export function BorderControl({
  storedStyles,
  currentStyles,
  onChange,
  onClearProperty,
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

  const widthState = readSideField(storedStyles, 'Width')
  const styleState = readSideField(storedStyles, 'Style')
  const colorState = readSideField(storedStyles, 'Color')

  const widthFallback = readSideField(currentStyles, 'Width')

  // All three fields uniform across all sides → the border is "linked".
  const borderUniform = widthState.uniform && styleState.uniform && colorState.uniform
  const borderAnySet = widthState.anySet || styleState.anySet || colorState.anySet

  const [linked, setLinked] = useState<boolean>(() => borderUniform || !borderAnySet)
  // Auto-relink (never auto-unlink — splitting is a deliberate user action).
  if (!linked && borderUniform) setLinked(true)

  const [activeSide, setActiveSide] = useState<Side>('Top')

  // The side whose values populate the inputs: 'Top' when linked, else the
  // user-selected side.
  const editSide: Side = linked ? 'Top' : activeSide

  const writeSide = (field: BorderField, value: string | number | undefined) => {
    const sides: Side[] = linked ? [...SIDES] : [editSide]
    for (const s of sides) onChange(borderKey(s, field), value)
  }

  // Transient preview counterpart to writeSide — builds a patch across the
  // same set of sides (all four when linked) and routes it through the
  // hover-preview channel without committing. Gated by the preference.
  const previewSide =
    hoverPreviewEnabled && onPreview
      ? (field: BorderField, value: string | number | undefined) => {
          const sides: Side[] = linked ? [...SIDES] : [editSide]
          const patch: Partial<CSSPropertyBag> = {}
          for (const s of sides) {
            ;(patch as Record<string, unknown>)[borderKey(s, field)] = value ?? null
          }
          onPreview(patch)
        }
      : undefined

  const clearBorder = () => {
    for (const side of SIDES) {
      for (const field of ['Width', 'Style', 'Color'] as BorderField[]) {
        onClearProperty(borderKey(side, field))
      }
    }
  }

  /** Collapse the four sides onto the edited one, then edit them together. */
  const relink = () => {
    for (const field of ['Width', 'Style', 'Color'] as BorderField[]) {
      const value = readSideField(storedStyles, field).perSide[editSide]
      for (const s of SIDES) onChange(borderKey(s, field), value || undefined)
    }
    setLinked(true)
  }

  const setScope = (scope: BorderScope) => {
    if (scope === 'all') {
      if (borderAnySet && !borderUniform) relink()
      else setLinked(true)
    } else {
      setActiveSide(editSide)
      setLinked(false)
    }
  }

  const widthValue = widthState.perSide[editSide]
  const styleValue = styleState.perSide[editSide]
  const colorValue = colorState.perSide[editSide]
  const widthPlaceholder = widthFallback.perSide[editSide] || '0px'
  const scopeName = linked ? 'all sides' : editSide.toLowerCase()

  const styleOptions = getEnumOptions('borderTopStyle') ?? []

  return (
    <div className={styles.root}>
      <EdgeBox
        linked={linked}
        activeSide={activeSide}
        onSelectSide={(side) => {
          setLinked(false)
          setActiveSide(side)
        }}
      />

      <div className={styles.scopeRow}>
        <Button
          variant="ghost"
          className={styles.sideChip}
          pressed={linked}
          aria-label={linked ? 'Editing all sides' : `Editing ${scopeName} side`}
          onClick={() => setScope(linked ? 'side' : 'all')}
        >
          <span className={styles.sideChipLabel}>
            {linked ? 'Editing all sides' : `Editing ${scopeName} side`}
          </span>
          <LinkIcon size={12} aria-hidden="true" />
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
            <RemoveXGlyph />
          </Button>
        )}
      </div>

      <div className={styles.rowStack}>
        <FieldRow label="Color">
          <ColorValueInput
            id={`border-${editSide}-color`}
            value={colorValue}
            ariaLabel={`Border ${scopeName} color`}
            swatchLabel={`Border ${scopeName} color swatch`}
            drillInTitle="Border color"
            onChange={(v) => writeSide('Color', v || undefined)}
            onPreview={onPreview ? (v) => previewSide?.('Color', v || undefined) : undefined}
            onClearPreview={onClearPreview}
          />
        </FieldRow>

        <FieldRow label="Width">
          <div className={styles.widthPair}>
            <Input
              fieldSize="xs"
              value={widthValue}
              placeholder={widthPlaceholder}
              aria-label={`Border ${scopeName} width`}
              onChange={(e) => writeSide('Width', e.target.value || undefined)}
            />
            <SegmentedControl<BorderScope>
              fullWidth
              aria-label="Border scope"
              value={linked ? 'all' : 'side'}
              options={[
                { value: 'all', icon: <AllSidesGlyph />, ariaLabel: 'All edges' },
                { value: 'side', icon: <PerSideGlyph />, ariaLabel: 'Edge separately' },
              ]}
              onChange={setScope}
            />
          </div>
        </FieldRow>

        <FieldRow label="Style">
          <Select
            fieldSize="xs"
            value={styleValue}
            aria-label={`Border ${scopeName} style`}
            onChange={(e) => writeSide('Style', e.target.value || undefined)}
            options={[
              { label: '—', value: '' },
              ...styleOptions.map((o) => ({ label: o, value: o })),
            ]}
            onOptionPreview={previewSide ? (v) => previewSide('Style', v || undefined) : undefined}
            onOptionPreviewClear={previewSide ? onClearPreview : undefined}
          />
        </FieldRow>

        {/* Outline has no row in the prototype; it keeps its existing pair. */}
        <FieldRow label="Outline">
          <Input
            fieldSize="xs"
            value={pickString(storedStyles.outline)}
            placeholder={pickString(currentStyles.outline) || 'none'}
            aria-label="Outline"
            onChange={(e) => onChange('outline', e.target.value || undefined)}
          />
        </FieldRow>
        <FieldRow label="Offset">
          <Input
            fieldSize="xs"
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
// FieldRow — the prototype's narrow row: 52px label column + control
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
// EdgeBox — the four clickable edges
// ---------------------------------------------------------------------------

interface EdgeBoxProps {
  linked: boolean
  activeSide: Side
  onSelectSide: (side: Side) => void
}

function EdgeBox({ linked, activeSide, onSelectSide }: EdgeBoxProps) {
  return (
    <div className={styles.edgeBox} role="group" aria-label="Border side">
      <div className={styles.edgeBoxInner}>
        {SIDES.map((side) => {
          const isActive = linked || side === activeSide
          return (
            <button
              key={side}
              type="button"
              className={cn(styles.edge, styles[`edge${side}`])}
              data-active={isActive ? 'true' : undefined}
              aria-label={`Edit ${side.toLowerCase()} border`}
              aria-pressed={isActive}
              onClick={() => onSelectSide(side)}
            />
          )
        })}
      </div>
    </div>
  )
}
