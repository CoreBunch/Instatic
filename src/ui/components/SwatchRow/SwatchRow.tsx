/**
 * SwatchRow — the inspector's popout-trigger row (prototype `.swatchrow`).
 *
 * One row anatomy for every property whose editor lives in a floating popout:
 * a 22px chip previewing the current paint, the value's name, and a clear
 * cross that shows whenever the row holds a value. The Styles section's Fill, Border and Shadows rows
 * are all this component.
 *
 * Two shapes, picked by which props you pass:
 *
 *   • `onClick` — the WHOLE row is the trigger (Border, Shadows). Chip and
 *     name sit inside one button.
 *   • no `onClick` — the chip is its own interactive element (Fill hands us a
 *     `ColorInput`, which owns the picker popover). The chip slot sizes it to
 *     the row; the name stays a passive label.
 *
 * The clear button is always a SIBLING of the trigger, never nested inside
 * it — a `<button>` inside a `<button>` is invalid HTML.
 */

import type { ReactNode, Ref } from 'react'
import { Button } from '@ui/components/Button'
import { AddPropertyGlyph, RemoveXGlyph } from '@ui/icons/inspectorGlyphs'
import styles from './SwatchRow.module.css'

interface SwatchRowProps {
  /**
   * Chip content. Omit for the default checkerboard chip (which shows a plus
   * when `isSet` is false); pass a node to supply your own — e.g. a
   * `ColorInput` trigger, which the chip slot sizes to the row.
   */
  chip?: ReactNode
  /** Inline style for the default chip (paint it via custom properties). */
  chipStyle?: React.CSSProperties
  /** Current value's name — "Solid", "FFFFFF", or the "Add…" placeholder. */
  name: string
  /** Whether the row holds a value. Drives the chip's plus and the name tone. */
  isSet: boolean
  /** Makes the whole row a trigger. Omit when the chip owns the interaction. */
  onClick?: () => void
  ariaLabel?: string
  ariaExpanded?: boolean
  /** Rendered as the in-field cross. Omit to leave the row unclearable. */
  onClear?: () => void
  clearLabel?: string
  /** Trigger ref — a floating editor opens beside THIS row, not beside the panel. */
  triggerRef?: Ref<HTMLButtonElement>
}

export function SwatchRow({
  chip,
  chipStyle,
  name,
  isSet,
  onClick,
  triggerRef,
  ariaLabel,
  ariaExpanded,
  onClear,
  clearLabel,
}: SwatchRowProps) {
  const chipNode = chip ? (
    <span className={styles.chipSlot}>{chip}</span>
  ) : (
    <span className={styles.chip} data-state={isSet ? 'set' : 'unset'} style={chipStyle} aria-hidden="true">
      {!isSet && <AddPropertyGlyph />}
    </span>
  )

  const nameNode = (
    <span className={styles.name} data-placeholder={isSet ? undefined : 'true'}>
      {name}
    </span>
  )

  return (
    <div className={styles.swatchRow}>
      {onClick ? (
        <Button
          ref={triggerRef}
          variant="ghost"
          className={styles.trigger}
          aria-haspopup="dialog"
          aria-expanded={ariaExpanded}
          aria-label={ariaLabel}
          onClick={onClick}
        >
          {chipNode}
          {nameNode}
        </Button>
      ) : (
        <>
          {chipNode}
          {nameNode}
        </>
      )}
      {onClear && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          className={styles.clear}
          aria-label={clearLabel}
          tooltip={clearLabel}
          onClick={onClear}
        >
          <RemoveXGlyph />
        </Button>
      )}
    </div>
  )
}
