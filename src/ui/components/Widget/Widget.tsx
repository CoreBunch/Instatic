/**
 * Widget — shared chrome for every dashboard tile.
 *
 * Renders the achromatic card surface, the title row (tint dot, icon,
 * title, optional action slot, drag handle, kebab menu), and the content
 * body. The grid span is set from outside via the `span` prop and
 * forwarded as a `data-span` attribute so the grid stylesheet can place
 * the card with `grid-column: span N`.
 *
 * First-party and plugin-registered widgets both compose this primitive
 * directly — `src/admin/pages/dashboard/widgets/*` and any plugin's
 * `editor/index.ts` that calls `api.dashboard.widgets.register(...)`.
 * The registry's metadata (name, icon, tint, defaultSize) is authoritative
 * only for the block picker; the widget body owns whatever it wants in
 * the title row (range tabs, plus buttons, etc.).
 *
 * The `tint` token is published as a CSS custom property (`--tint`) so
 * children (chart primitives, bars, sparkline gradients) can read it
 * directly through the cascade without prop drilling.
 *
 * Lives under `src/ui/components/` — NOT `src/admin/pages/dashboard/` —
 * so plugins can import it via `@instatic/host-ui`. The four allowed
 * `tint` tokens are the same four `--accent-*` accents declared in
 * `src/styles/globals.css`.
 */
import { type CSSProperties, type ReactNode } from 'react'
import type { IconComponent } from 'pixel-art-icons/types'
import { DragAndDropSolidIcon } from 'pixel-art-icons/icons/drag-and-drop-solid'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
import { Button } from '@ui/components/Button'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { cn } from '@ui/cn'
import styles from './Widget.module.css'

/**
 * Accent tints reserved for dashboard widgets. Mirrors the four
 * `--accent-*` tokens in `src/styles/globals.css`. The chrome reads
 * `--tint` from the chosen value to color the title-dot and to flow
 * through to any chart primitive composed inside (via `var(--tint)` in
 * the chart's CSS module fallback).
 */
export type WidgetTint = 'mint' | 'lilac' | 'sky' | 'peach'

/**
 * Icon component shape — the vendored `pixel-art-icons` package's standard
 * `IconComponent` type. Every `pixel-art-icons/icons/<name>` deep import
 * matches this shape, so first-party widgets and plugin-authored widgets
 * use the same icon imports.
 */
export type WidgetIcon = IconComponent

export interface WidgetProps {
  /** Identifier — used by the DnD layer to track this card. */
  widgetId: string
  title: string
  icon?: WidgetIcon
  tint: WidgetTint
  /** Grid column span (1 .. 12). */
  span: number
  /** Optional action slot rendered between the title and the drag handle. */
  action?: ReactNode
  /**
   * True when the dashboard is in customize mode (drag handle becomes
   * visible, hover ring appears). Plugin widgets receive this through
   * the `DashboardWidgetRendererProps` and pass it straight through.
   */
  editing: boolean
  /**
   * True while the widget is fetching its initial data. Renders
   * `aria-busy="true"` on the section so assistive tech announces the
   * loading state, and lets the widget body render `<Skeleton>` shapes
   * without each widget repeating the ARIA wiring.
   */
  loading?: boolean
  children?: ReactNode
}

const TINT_TOKEN: Record<WidgetTint, string> = {
  mint: 'var(--accent-1)',
  lilac: 'var(--accent-2)',
  sky: 'var(--accent-3)',
  peach: 'var(--accent-4)',
}

/**
 * Renderless placeholder version of the widget chrome — used by the
 * dashboard grid for layout slots whose widget definition isn't yet
 * available (typical case: a plugin-registered widget that's still
 * being loaded by `useInstalledEditorPlugins`).
 *
 * Without this, the grid would render `null` for those slots, leaving
 * empty holes that then snap into a real widget without any skeleton.
 * `WidgetSkeleton` paints a full Widget-shaped placeholder (dot +
 * title placeholder + skeleton body) so the slot reads as "loading"
 * from first paint until the real widget swaps in.
 *
 * Accepts only `span` — title / icon / tint aren't known until the
 * definition arrives; the placeholder is intentionally generic.
 */
interface WidgetSkeletonProps {
  /** Stable id from the layout slot — used for DnD tracking + DOM diffing. */
  widgetId: string
  /** Grid column span (1 .. 12), read from the layout slot. */
  span: number
}

export function WidgetSkeleton({ widgetId, span }: WidgetSkeletonProps) {
  return (
    <section
      className={styles.widget}
      data-widget={widgetId}
      data-span={span}
      aria-busy="true"
      aria-label="Loading widget"
    >
      <header className={styles.head}>
        <div className={styles.title}>
          <span className={cn(styles.dot, styles.dotPlaceholder)} />
          <SkeletonBlockTitle />
        </div>
      </header>
      <SkeletonBlock />
    </section>
  )
}

/** Inline title placeholder — narrow shimmer line matching the
 * widget's uppercase title text dimensions. Kept inline (not a full
 * `SkeletonBlock`) so the title row's other adornments line up. */
function SkeletonBlockTitle() {
  return (
    <span className={styles.titlePlaceholder}>
      <span className={styles.titlePlaceholderBar} />
    </span>
  )
}

export function Widget({
  widgetId,
  title,
  icon: TitleIcon,
  tint,
  span,
  action,
  editing,
  loading = false,
  children,
}: WidgetProps) {
  const style: CSSProperties = {
    ['--tint' as string]: TINT_TOKEN[tint],
  }

  return (
    <section
      className={cn(styles.widget, editing && styles.editing)}
      style={style}
      data-widget={widgetId}
      data-span={span}
      aria-busy={loading || undefined}
    >
      <header className={styles.head}>
        <div className={styles.title}>
          <span className={styles.dot} />
          {TitleIcon && <TitleIcon size={11} aria-hidden="true" />}
          <span>{title}</span>
        </div>
        <div className={styles.headEnd}>
          {action}
          {editing ? (
            <span className={styles.handle} aria-hidden="true">
              <DragAndDropSolidIcon size={12} />
            </span>
          ) : (
            <Button
              variant="ghost"
              size="micro"
              iconOnly
              className={styles.menu}
              aria-label={`${title} options`}
            >
              <MoreHorizontalSolidIcon size={12} />
            </Button>
          )}
        </div>
      </header>
      {loading ? <SkeletonBlock /> : children}
    </section>
  )
}
