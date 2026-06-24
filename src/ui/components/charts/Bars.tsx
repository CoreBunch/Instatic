/**
 * Bars — a horizontal row of vertical bars sized by the input array.
 *
 * Useful for "posts by week", "events by day", or any small categorical
 * distribution. Each bar's pixel height is computed from the value /
 * max ratio. Bars at indexes listed in `accentIndexes` render at full
 * opacity to highlight the active selection (e.g. last 7 days).
 *
 * Exposed via the plugin SDK as `Bars`.
 */
import styles from './charts.module.css'

export interface BarsProps {
  /** Values, in left-to-right render order. */
  data: readonly number[]
  /**
   * Fill colour for every bar. When omitted, falls back to the global
   * `--chart-default-tint` token (currently `var(--accent-4)`),
   * unless an ambient `--tint` is set by a parent (e.g. the dashboard
   * `Widget` chrome) — in which case the ambient value wins.
   *
   * Recommended override values — use a design-system accent token:
   * - `'var(--accent-1)'`  — green
   * - `'var(--accent-2)'` — violet
   * - `'var(--accent-3)'`   — blue
   * - `'var(--accent-4)'` — warm orange
   */
  tint?: string
  /**
   * Pixel height of the bar track. Each bar's height is `value / max * height`.
   * Default: 76.
   */
  height?: number
  /**
   * Indexes that should render at full opacity. Other bars render at 0.5
   * opacity so the highlight reads as a "current" selection on top of a
   * muted historical baseline. Defaults to none (every bar muted).
   */
  accentIndexes?: readonly number[]
  /** Pixel gap between bars. Default: 3. */
  gap?: number
}

export function Bars({
  data,
  tint,
  height = 76,
  accentIndexes,
  gap = 3,
}: BarsProps) {
  const max = Math.max(1, ...data)
  const accentSet = accentIndexes ? new Set(accentIndexes) : null

  // `--tint` is always set on the parent widget root (the Widget chrome
  // declares it on `.widget`). When `tint` is omitted, we forward the
  // widget's tint via `var(--tint)` — no fallback needed since the host
  // selector always provides a value.
  const tintValue = tint ?? 'var(--tint)'

  return (
    <div
      className={styles.bars}
      style={{
        ['--bars-cols' as string]: String(data.length),
        ['--bars-height' as string]: `${height}px`,
        ['--bars-gap' as string]: `${gap}px`,
        ['--bars-tint' as string]: tintValue,
      }}
      aria-hidden="true"
    >
      {data.map((v, i) => {
        const px = Math.max(2, Math.round((v / max) * height))
        const active = accentSet?.has(i) ?? false
        return (
          <span
            key={i}
            className={active ? styles.barActive : undefined}
            style={{ height: px }}
          />
        )
      })}
    </div>
  )
}
