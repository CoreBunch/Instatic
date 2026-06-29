/**
 * FrameworkHome — the Framework panel's overview tab.
 *
 * Three activation cards (Colors / Typography / Space) each show whether that
 * part of the framework is active and a count; the Colors card also previews
 * the palette as a swatch grid. Clicking a card jumps to its tab. A footer
 * button opens the Manage Core Framework dialog (import / remove / prune).
 */
import { type CSSProperties, type ReactNode } from 'react'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { RulerDimensionSolidIcon } from 'pixel-art-icons/icons/ruler-dimension-solid'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import type { PixelArtIconComponent } from '@core/dashboard'
import type { FrameworkColorToken } from '@core/framework-schema'
import type { FrameworkPanelTab } from '@site/store/slices/uiSlice'
import styles from './FrameworkHome.module.css'

const MAX_SWATCHES = 12

// Stable empty fallbacks — returning a fresh `?? []` from a Zustand selector
// changes the snapshot identity every render and loops forever.
const EMPTY_TOKENS: readonly FrameworkColorToken[] = []
const EMPTY_GROUPS: readonly { id: string }[] = []

export function FrameworkHome() {
  const colorTokens = useEditorStore(
    (s) => s.site?.settings.framework?.colors?.tokens ?? EMPTY_TOKENS,
  )
  const typographyGroups = useEditorStore(
    (s) => s.site?.settings.framework?.typography?.groups ?? EMPTY_GROUPS,
  )
  const spacingGroups = useEditorStore(
    (s) => s.site?.settings.framework?.spacing?.groups ?? EMPTY_GROUPS,
  )
  const setTab = useEditorStore((s) => s.setFrameworkPanelTab)
  const setManagerOpen = useEditorStore((s) => s.setFrameworkManagerOpen)

  const swatches = colorTokens.slice(0, MAX_SWATCHES)

  function countLabel(active: boolean, count: number, noun: string): string {
    if (!active) return 'Not activated'
    return `${count} ${noun}${count === 1 ? '' : 's'}`
  }

  function card(
    tab: FrameworkPanelTab,
    title: string,
    Icon: PixelArtIconComponent,
    active: boolean,
    label: string,
    preview?: ReactNode,
  ) {
    return (
      <button
        type="button"
        className={styles.card}
        data-active={active ? 'true' : undefined}
        onClick={() => setTab(tab)}
      >
        <span className={styles.cardHead}>
          <span className={styles.cardIcon} aria-hidden="true">
            <Icon size={16} />
          </span>
          <span className={styles.cardTitle}>{title}</span>
          <span className={styles.cardStatus} data-active={active ? 'true' : undefined}>
            {active ? 'Active' : 'Off'}
          </span>
        </span>
        <span className={styles.cardCount}>{label}</span>
        {preview}
      </button>
    )
  }

  return (
    <div className={styles.home}>
      <div className={styles.cards}>
        {card(
          'colors',
          'Colors',
          ColorsSwatchSolidIcon,
          colorTokens.length > 0,
          countLabel(colorTokens.length > 0, colorTokens.length, 'color'),
          colorTokens.length > 0 ? (
            <span className={styles.swatches} aria-hidden="true">
              {swatches.map((token) => (
                <span
                  key={token.id}
                  className={styles.swatch}
                  style={{ '--swatch': token.lightValue } as CSSProperties}
                />
              ))}
            </span>
          ) : undefined,
        )}
        {card(
          'typography',
          'Typography',
          TextStartTIcon,
          typographyGroups.length > 0,
          countLabel(typographyGroups.length > 0, typographyGroups.length, 'scale'),
        )}
        {card(
          'spacing',
          'Space',
          RulerDimensionSolidIcon,
          spacingGroups.length > 0,
          countLabel(spacingGroups.length > 0, spacingGroups.length, 'scale'),
        )}
      </div>

      <div className={styles.manageRow}>
        <Button variant="secondary" size="sm" onClick={() => setManagerOpen(true)}>
          <SlidersHorizontalIcon size={13} aria-hidden="true" />
          Manage framework
        </Button>
      </div>
    </div>
  )
}
