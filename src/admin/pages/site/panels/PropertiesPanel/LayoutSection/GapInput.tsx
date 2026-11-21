/**
 * GapInput — token-aware text input for `gap` (writes the unified shorthand).
 *
 * Promotes the `gap` row out of the fallback list and into the flex / grid
 * blocks where it belongs (right below Justify). Backed by `TokenAwareInput`
 * so users get framework spacing variable autocomplete as they type — same
 * vocabulary as the SpacingBoxControl side inputs.
 */

import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { LabeledControl } from './LabeledControl'

interface GapInputProps {
  value: string | undefined
  isSet: boolean
  onChange: (value: string | undefined) => void
  /** Hover / as-you-type preview of the resolved gap value (token-aware). */
  onPreview?: (value: string | undefined) => void
  onClearPreview?: () => void
}

export function GapInput({ value, isSet, onChange, onPreview, onClearPreview }: GapInputProps) {
  const tokens = useSpacingTokens()
  return (
    <LabeledControl label="Gap" isSet={isSet}>
      <TokenAwareInput adjustable minimum={0}
        aria-label="Gap"
        value={value}
        placeholder="0px"
        tokens={tokens}
        onCommit={onChange}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
      />
    </LabeledControl>
  )
}
