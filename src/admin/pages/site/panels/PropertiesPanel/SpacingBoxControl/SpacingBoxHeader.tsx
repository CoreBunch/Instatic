/**
 * SpacingBoxHeader — the `MARGIN` / `PADDING` caption in a spacing box's top
 * band and its hover-revealed actions: link all four sides, clear the box.
 */

import { Button } from '@ui/components/Button'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { RemoveXGlyph } from '@ui/icons/inspectorGlyphs'
import styles from './SpacingBoxControl.module.css'

interface SpacingBoxHeaderProps {
  label: string
  linked: boolean
  onToggleLinked: () => void
  /** Nothing stored on this box — Clear has nothing to do. */
  clearDisabled: boolean
  onClear: () => void
}

export function SpacingBoxHeader({
  label,
  linked,
  onToggleLinked,
  clearDisabled,
  onClear,
}: SpacingBoxHeaderProps) {
  return (
    <div className={styles.boxHeader}>
      <span className={styles.boxLabel}>{label}</span>
      <div className={styles.boxHeaderActions}>
        <Button
          type="button"
          variant="ghost"
          size="micro"
          iconOnly
          onClick={onToggleLinked}
          aria-pressed={linked}
          aria-label={linked ? `Unlink ${label} sides` : `Link all ${label} sides`}
          tooltip={linked ? 'Linked — edits all four sides' : 'Split — edit each side separately'}
          className={styles.headerBtn}
        >
          <LinkIcon size={11} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="micro"
          iconOnly
          onClick={onClear}
          disabled={clearDisabled}
          aria-label={`Clear ${label}`}
          tooltip={`Clear ${label}`}
          className={styles.headerBtn}
        >
          <RemoveXGlyph />
        </Button>
      </div>
    </div>
  )
}
