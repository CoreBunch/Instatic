/**
 * GridAxisControl â€” alignItems / justifyItems for grid containers.
 *
 * Reuses the flex CROSS_HORIZONTAL_OPTIONS / CROSS_VERTICAL_OPTIONS icon
 * sets â€” same `flex-start | center | flex-end | stretch | baseline` value
 * keywords work in both flex and grid containers per CSS Box Alignment
 * Module 3 (self-position keywords). The single source of truth keeps
 * the visual language consistent when users toggle display modes on a
 * class that already has alignItems set.
 */

import { SegmentedControl } from '@ui/components/SegmentedControl'
import { LabeledControl } from './LabeledControl'
import { CROSS_HORIZONTAL_OPTIONS, CROSS_VERTICAL_OPTIONS } from './alignmentOptions'

interface GridAxisControlProps {
  label: string
  /** 'block' = alignItems (vertical), 'inline' = justifyItems (horizontal). */
  axis: 'block' | 'inline'
  value: string | undefined
  isSet: boolean
  onChange: (value: string) => void
  onClear: () => void
}

export function GridAxisControl({ label, axis, value, isSet, onChange, onClear }: GridAxisControlProps) {
  // alignItems (block axis) â†’ items are stacked vertically inside their cell;
  // visualised via horizontal-row icons (start = top, end = bottom).
  // justifyItems (inline axis) â†’ items spread horizontally; visualised via
  // vertical-column icons (start = left, end = right).
  const options = axis === 'block' ? CROSS_HORIZONTAL_OPTIONS : CROSS_VERTICAL_OPTIONS
  return (
    <LabeledControl label={label} isSet={isSet}>
      <SegmentedControl
        look="tiles"
        fullWidth
        aria-label={axis === 'block' ? 'Align items' : 'Justify items'}
        value={value}
        onChange={onChange}
        onClear={onClear}
        options={options}
      />
    </LabeledControl>
  )
}
