/**
 * FlexWrapControl â€” 3 segments (Nowrap / Wrap / Wrap-reverse) for `flex-wrap`.
 */

import { SegmentedControl } from '@ui/components/SegmentedControl'
import { TextWrapIcon } from 'pixel-art-icons/icons/text-wrap'
import { ControlRow } from '@ui/components/ControlRow'

interface FlexWrapControlProps {
  value: string | undefined
  isSet: boolean
  onChange: (value: string) => void
  onClear: () => void
}

export function FlexWrapControl({ value, isSet, onChange, onClear }: FlexWrapControlProps) {
  return (
    <ControlRow label="Wrap" isSet={isSet}>
      <SegmentedControl
        look="tiles"
        fullWidth
        aria-label="Flex wrap"
        value={value}
        onChange={onChange}
        onClear={onClear}
        options={[
          {
            value: 'nowrap',
            label: 'No',
            ariaLabel: 'No wrap',
            tooltip: 'nowrap',
          },
          {
            value: 'wrap',
            icon: <TextWrapIcon size={14} />,
            ariaLabel: 'Wrap',
            tooltip: 'wrap',
          },
          {
            value: 'wrap-reverse',
            label: 'Rev',
            ariaLabel: 'Wrap reverse',
            tooltip: 'wrap-reverse',
          },
        ]}
      />
    </ControlRow>
  )
}
