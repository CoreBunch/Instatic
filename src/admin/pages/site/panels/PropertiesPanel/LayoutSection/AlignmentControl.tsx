/**
 * AlignmentControl â€” connected icon buttons for align-items (cross axis) and
 * justify-content (main axis). The icon set rotates with flex-direction so
 * cross-axis vs main-axis stays visually obvious.
 */

import { SegmentedControl } from '@ui/components/SegmentedControl'
import { LabeledControl } from './LabeledControl'
import {
  CROSS_HORIZONTAL_OPTIONS,
  CROSS_VERTICAL_OPTIONS,
  MAIN_HORIZONTAL_OPTIONS,
  MAIN_VERTICAL_OPTIONS,
} from './alignmentOptions'

type AlignAxis = 'cross' | 'main'

interface AlignmentControlProps {
  axis: AlignAxis
  flexDirection: string
  value: string | undefined
  isSet: boolean
  onChange: (value: string) => void
  onClear: () => void
  label: string
}

export function AlignmentControl({
  axis,
  flexDirection,
  value,
  isSet,
  onChange,
  onClear,
  label,
}: AlignmentControlProps) {
  // The icon set is keyed off the *main-axis* orientation:
  //   - direction: row | row-reverse        â†’ main is horizontal, cross is vertical
  //   - direction: column | column-reverse  â†’ main is vertical,   cross is horizontal
  // Both MAIN and CROSS arrays are named after the direction items flow
  // (i.e. the main axis), so we just pick the matching pair.
  const isMainHorizontal =
    flexDirection === 'row' || flexDirection === 'row-reverse'

  const options = isMainHorizontal
    ? axis === 'main'
      ? MAIN_HORIZONTAL_OPTIONS
      : CROSS_HORIZONTAL_OPTIONS
    : axis === 'main'
      ? MAIN_VERTICAL_OPTIONS
      : CROSS_VERTICAL_OPTIONS

  return (
    <LabeledControl label={label} isSet={isSet}>
      <SegmentedControl
        look="tiles"
        fullWidth
        aria-label={axis === 'main' ? 'Justify content' : 'Align items'}
        value={value}
        onChange={onChange}
        onClear={onClear}
        options={options}
      />
    </LabeledControl>
  )
}
