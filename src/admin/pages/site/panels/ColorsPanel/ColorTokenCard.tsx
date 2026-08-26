import { type MouseEvent } from 'react'
import { ColorInput } from '@ui/components/ColorInput'
import type { FrameworkColorToken } from '@core/framework-schema'
import type { UpdateFrameworkColorTokenPatch } from '@site/store/slices/site/types'
import { ColorTokenEditor } from './ColorTokenEditor'
import styles from './ColorTokenCard.module.css'

interface ColorTokenCardProps {
  token: FrameworkColorToken
  categories: string[]
  expanded: boolean
  onToggle: () => void
  onPatch: (patch: UpdateFrameworkColorTokenPatch) => void
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
}

export function ColorTokenCard({
  token,
  categories,
  expanded,
  onToggle,
  onPatch,
  onContextMenu,
}: ColorTokenCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.row} onContextMenu={onContextMenu}>
        <span className={styles.swatches}>
          <ColorInput
            value={token.lightValue}
            swatchValue={token.lightValue}
            fieldSize="xs"
            aria-label={`Default color swatch ${token.slug}`}
            onValueChange={(next) => onPatch({ lightValue: next })}
          />
          {token.darkModeEnabled && (
            <ColorInput
              value={token.darkValue}
              swatchValue={token.darkValue}
              fieldSize="xs"
              aria-label={`Alternate color swatch ${token.slug}`}
              onValueChange={(next) =>
                onPatch({ darkValue: next, darkModeEnabled: true })
              }
            />
          )}
        </span>
        {/* §8.7 — full-width structured row toggle (title + meta, expand caret pattern).
            Button's inline-flex sizing and padding cannot represent this multi-cell layout. */}
        <button
          type="button"
          className={styles.rowToggle}
          aria-expanded={expanded}
          aria-label={`Edit color ${token.slug}`}
          onClick={onToggle}
          onContextMenu={onContextMenu}
        >
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>--{token.slug}</span>
            <span className={styles.rowMeta}>
              {token.category.trim() || 'Uncategorized'}
            </span>
          </span>
        </button>
      </div>

      {expanded && (
        <ColorTokenEditor
          token={token}
          categories={categories}
          onPatch={onPatch}
        />
      )}
    </div>
  )
}
