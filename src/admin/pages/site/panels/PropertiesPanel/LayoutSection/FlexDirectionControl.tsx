/**
 * FlexDirectionControl â€” 4 connected icon buttons (row, column, and reverses)
 * for `flex-direction`.
 */

import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { ArrowLeftIcon } from 'pixel-art-icons/icons/arrow-left'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { ArrowUpIcon } from 'pixel-art-icons/icons/arrow-up'
import { LabeledControl } from './LabeledControl'

interface FlexDirectionControlProps {
  value: string | undefined
  isSet: boolean
  onChange: (value: string) => void
  onClear: () => void
}

export function FlexDirectionControl({ value, isSet, onChange, onClear }: FlexDirectionControlProps) {
  return (
    <LabeledControl label="Direction" isSet={isSet}>
      <SegmentedControl
        look="tiles"
        fullWidth
        aria-label="Flex direction"
        value={value}
        onChange={onChange}
        onClear={onClear}
        options={[
          {
            value: 'row',
            icon: <ArrowRightIcon size={14} />,
            ariaLabel: 'Row',
            tooltip: 'row',
          },
          {
            value: 'column',
            icon: <ArrowDownIcon size={14} />,
            ariaLabel: 'Column',
            tooltip: 'column',
          },
          {
            value: 'row-reverse',
            icon: <ArrowLeftIcon size={14} />,
            ariaLabel: 'Row reverse',
            tooltip: 'row-reverse',
          },
          {
            value: 'column-reverse',
            icon: <ArrowUpIcon size={14} />,
            ariaLabel: 'Column reverse',
            tooltip: 'column-reverse',
          },
        ]}
      />
    </LabeledControl>
  )
}
