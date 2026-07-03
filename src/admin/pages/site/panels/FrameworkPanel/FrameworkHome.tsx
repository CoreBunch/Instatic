/**
 * FrameworkHome — the Framework panel's overview tab.
 *
 * Three cards (Colors / Typography / Space), each a click target that opens its
 * tab (a hover arrow signals it), with a live preview:
 *   • Colors — a row of pill swatches, each composited over a neutral base so
 *     dark, white, and translucent tokens all read; hover floats its slug.
 *   • Typography — a type specimen: a display title + a body paragraph rendered
 *     in the site's font tokens (heading = token #1, body = token #2), each line
 *     labelled with its CSS variable; falls back to installed families, then to
 *     the system stack a fresh text module renders in.
 *   • Space — the Space panel's own SpacingBarChart, fed by the same fluid
 *     computation so the overview and the panel match exactly.
 *
 * A footer button opens the Manage Core Framework dialog (import / remove / prune).
 */
import { type CSSProperties, type ReactNode } from 'react'
import { useEditorStore } from '@site/store/store'
import { useInstalledFontFaces } from '@site/hooks/useInstalledFontFaces'
import { Button } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { RulerDimensionSolidIcon } from 'pixel-art-icons/icons/ruler-dimension-solid'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import type { PixelArtIconComponent } from '@core/dashboard'
import type { FrameworkColorToken, FrameworkSpacingGroup } from '@core/framework-schema'
import type { FontEntry, FontToken } from '@core/fonts'
import {
  fontFamilyStackForEntry,
  resolveFontTokenStack,
  sortFontTokens,
} from '@core/fonts'
import { computeFluidScale, effectiveScaleRatio, resolveFrameworkPreferences } from '@core/framework'
import { SpacingBarChart, type ChartPoint } from '@site/panels/SpacingPanel'
import type { FrameworkPanelTab } from '@site/store/slices/uiSlice'
import styles from './FrameworkHome.module.css'

/** Cap the palette so a large library stays a clean row, not slivers. */
const MAX_SWATCHES = 14

/** Specimen copy — reads as real content so the fonts are shown in context. */
const SPECIMEN_TITLE = 'Type that scales.'
const SPECIMEN_BODY =
  'Every size flows from one fluid scale — set it once and your type stays in proportion on any screen.'

// Stable empty fallbacks — returning a fresh `?? []` from a Zustand selector
// changes the snapshot identity every render and loops forever.
const EMPTY_TOKENS: readonly FrameworkColorToken[] = []
const EMPTY_SPACING: readonly FrameworkSpacingGroup[] = []
const EMPTY_FONT_ITEMS: readonly FontEntry[] = []
const EMPTY_FONT_TOKENS: readonly FontToken[] = []

export function FrameworkHome() {
  const colorTokens = useEditorStore(
    (s) => s.site?.settings.framework?.colors?.tokens ?? EMPTY_TOKENS,
  )
  const spacingGroups = useEditorStore(
    (s) => s.site?.settings.framework?.spacing?.groups ?? EMPTY_SPACING,
  )
  const frameworkPreferences = useEditorStore(
    (s) => s.site?.settings.framework?.preferences ?? null,
  )
  // Fonts are read with the same tolerant `?.items ?? EMPTY` selector pattern
  // as FontsSection: the store shape is guaranteed by validation on every load
  // path, but a malformed `settings.fonts` written by an unvalidated writer
  // must degrade to the empty library here — not crash the whole editor body.
  const fontsSettings = useEditorStore((s) => s.site?.settings.fonts ?? null)
  const fontItems = useEditorStore((s) => s.site?.settings.fonts?.items ?? EMPTY_FONT_ITEMS)
  const rawFontTokens = useEditorStore((s) => s.site?.settings.fonts?.tokens ?? EMPTY_FONT_TOKENS)
  const setTab = useEditorStore((s) => s.setFrameworkPanelTab)
  const setManagerOpen = useEditorStore((s) => s.setFrameworkManagerOpen)

  useInstalledFontFaces(fontItems, 'instatic-framework-home-fonts')

  const swatches = colorTokens.slice(0, MAX_SWATCHES)

  // The specimen renders in the user's own fonts. Font *tokens* win when present:
  // they carry the role intent (heading = first token, body = second — or the
  // first when there's only one), and each line is labelled with the token's CSS
  // variable so the preview reads in the same terms the site author authors in.
  // With no tokens we fall back to the first two installed families (labelled by
  // family name); with neither, both lines use the CSS system stack — the same
  // default a fresh text module renders in.
  const fontTokens = sortFontTokens(rawFontTokens)
  const headingToken = fontTokens[0]
  const bodyToken = fontTokens[1] ?? fontTokens[0]
  const bodyEntry = fontItems[1] ?? fontItems[0]

  const titleStack = headingToken
    ? resolveFontTokenStack(headingToken, fontsSettings)
    : fontItems[0]
      ? fontFamilyStackForEntry(fontItems[0])
      : undefined
  const bodyStack = bodyToken
    ? resolveFontTokenStack(bodyToken, fontsSettings)
    : bodyEntry
      ? fontFamilyStackForEntry(bodyEntry)
      : undefined

  const titleLabel = headingToken
    ? `Heading · --${headingToken.variable}`
    : fontItems[0]
      ? `Heading · ${fontItems[0].family}`
      : 'Heading'
  const bodyLabel = bodyToken
    ? `Body · --${bodyToken.variable}`
    : bodyEntry
      ? `Body · ${bodyEntry.family}`
      : 'Body'

  const spacingPoints = buildSpacingChartPoints(spacingGroups[0], frameworkPreferences)

  function card(
    tab: FrameworkPanelTab,
    title: string,
    Icon: PixelArtIconComponent,
    preview: ReactNode,
  ) {
    return (
      <button type="button" className={styles.card} onClick={() => setTab(tab)}>
        <span className={styles.cardHead}>
          <span className={styles.cardIcon} aria-hidden="true">
            <Icon size={16} />
          </span>
          <span className={styles.cardTitle}>{title}</span>
          <span className={styles.cardGo} aria-hidden="true">
            <ArrowRightIcon size={14} />
          </span>
        </span>
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
          colorTokens.length > 0 ? (
            <span className={styles.palette} aria-hidden="true">
              {swatches.map((token) => (
                <Tooltip key={token.id} content={`${token.slug} · ${token.lightValue}`}>
                  <span
                    className={styles.paletteCell}
                    style={{ '--swatch': token.lightValue } as CSSProperties}
                  />
                </Tooltip>
              ))}
            </span>
          ) : (
            <span className={styles.cardEmpty}>Click here to create your first color</span>
          ),
        )}
        {card(
          'typography',
          'Typography',
          TextStartTIcon,
          <span
            className={styles.specimen}
            style={
              {
                ...(titleStack ? { '--specimen-title': titleStack } : {}),
                ...(bodyStack ? { '--specimen-body': bodyStack } : {}),
              } as CSSProperties
            }
          >
            <span className={styles.specimenRow}>
              <span className={styles.specimenLabel}>{titleLabel}</span>
              <span className={styles.specimenTitle}>{SPECIMEN_TITLE}</span>
            </span>
            <span className={styles.specimenRow}>
              <span className={styles.specimenLabel}>{bodyLabel}</span>
              <span className={styles.specimenBody}>{SPECIMEN_BODY}</span>
            </span>
          </span>,
        )}
        {card(
          'spacing',
          'Space',
          RulerDimensionSolidIcon,
          spacingPoints ? (
            <span className={styles.scale}>
              <SpacingBarChart points={spacingPoints} />
            </span>
          ) : (
            <span className={styles.cardEmpty}>Click here to create your spacing scale</span>
          ),
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

/**
 * Build the spacing chart `points` from the first spacing group using the same
 * fluid computation the Space panel charts, so the Home preview renders the
 * exact same `SpacingBarChart`. Returns null when there is no group / no steps.
 */
function buildSpacingChartPoints(
  group: FrameworkSpacingGroup | undefined,
  preferencesRaw: Parameters<typeof resolveFrameworkPreferences>[0],
): ChartPoint[] | null {
  if (!group) return null
  const stepLabels = group.steps.split(',').map((step) => step.trim()).filter(Boolean)
  if (stepLabels.length === 0) return null

  const preferences = resolveFrameworkPreferences(preferencesRaw)
  const baseScaleIndex = Math.max(0, Math.min(group.baseScaleIndex, stepLabels.length - 1))
  const fluid = computeFluidScale({
    minBaseSize: group.min.size,
    maxBaseSize: group.max.size,
    minScaleRatio: effectiveScaleRatio(
      group.min.scaleRatio,
      group.min.isCustomScaleRatio,
      group.min.scaleRatioInputValue,
    ),
    maxScaleRatio: effectiveScaleRatio(
      group.max.scaleRatio,
      group.max.isCustomScaleRatio,
      group.max.scaleRatioInputValue,
    ),
    steps: stepLabels.length,
    baseScaleIndex,
    minScreenWidth: preferences.minScreenWidth,
    maxScreenWidth: preferences.maxScreenWidth,
  })

  return fluid.map((step, index) => ({
    stepLabel: stepLabels[index] ?? '',
    variableName: `--${group.namingConvention}-${stepLabels[index] ?? ''}`,
    minPx: Number(step.min),
    maxPx: Number(step.max),
    isBase: index === baseScaleIndex,
  }))
}
