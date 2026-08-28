/**
 * BorderPopoutRow — the border editor as ONE panel row plus a floating editor.
 *
 * The prototype pulls the border's multi-row editor out of the inspector: the
 * panel keeps a single `.swatchrow` trigger (chip · style name · clear) and
 * the edge picker, scope chip, colour, width and style rows move into the
 * same floating shell the colour picker already rides in.
 *
 * The shell is the shared `FloatingPanel` — the same one the colour picker
 * and the effect rows ride in, so it opens BESIDE this row instead of at a
 * remembered desk position: a popout belongs to the control that opened it.
 */

import { useRef, useState, type CSSProperties } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { SwatchRow } from '@ui/components/SwatchRow'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { BorderControl } from './BorderControl'
import styles from './BorderPopoutRow.module.css'

/** Sides in the order the longhands are read for the trigger's summary. */
const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const

interface BorderPopoutRowProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  /** Breakpoint tab id — the editor remounts per tab, like the other rows. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

function readFirstSet(styles: Record<string, unknown>, field: 'Style' | 'Color'): string {
  for (const side of SIDES) {
    const value = styles[`border${side}${field}`]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

export function BorderPopoutRow({
  storedStyles,
  currentStyles,
  activeTab,
  onChange,
  onClearProperty,
  onPreview,
  onClearPreview,
}: BorderPopoutRowProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const style = readFirstSet(storedStyles, 'Style')
  const color = readFirstSet(storedStyles, 'Color')
  const isSet = style !== '' || color !== ''

  // Title-case the CSS keyword for the row summary ("solid" → "Solid").
  const summary = style === '' ? 'Add…' : style.charAt(0).toUpperCase() + style.slice(1)

  function clearBorder() {
    for (const side of SIDES) {
      onClearProperty(`border${side}Width` as keyof CSSPropertyBag)
      onClearProperty(`border${side}Style` as keyof CSSPropertyBag)
      onClearProperty(`border${side}Color` as keyof CSSPropertyBag)
    }
  }

  return (
    <>
      <SwatchRow
        name={summary}
        isSet={isSet}
        // The chip paints the stored colour as a ring; an unset border falls
        // back to the panel's own hairline so it is still visible.
        chipStyle={
          {
            '--swatch-chip-ring': `inset 0 0 0 2px ${color || 'var(--border-strong)'}, inset 0 0 0 3px var(--overlay-20)`,
          } as CSSProperties
        }
        triggerRef={triggerRef}
        onClick={() => setOpen((current) => !current)}
        ariaExpanded={open}
        ariaLabel={isSet ? `Edit border — ${summary}` : 'Add a border'}
        onClear={isSet ? clearBorder : undefined}
        clearLabel="Clear border"
      />

      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        title="Border"
        closeLabel="Close border editor"
        estimatedHeight={280}
      >
        <div className={styles.popoutBody}>
          <BorderControl
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChange={onChange}
            onClearProperty={onClearProperty}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </div>
      </FloatingPanel>
    </>
  )
}
