/**
 * StackedBar — a single horizontal segmented bar with a legend.
 *
 * The Storage widget is the archetypal use case ("media: 920 MB · pages:
 * 240 MB · plugins: 180 MB"), but it generalises to any "used / total"
 * breakdown where individual categories should be visually proportional.
 *
 * The remaining (unused) portion is rendered as a final empty segment
 * filling whatever space is left after the named categories. If the
 * total of `segments` exceeds `total`, the bar saturates at 100%.
 *
 * Exposed via the plugin SDK as `StackedBar`.
 */
import styles from './charts.module.css'

export interface StackedBarSegment {
  /** Display label — rendered in the legend. */
  label: string
  /** Numeric magnitude — relative to `total`. */
  value: number
  /**
   * Bar/swatch colour for this segment. Required — `StackedBar` has no
   * single global tint because each segment carries a distinct colour.
   * Use design-system accent tokens for visual consistency:
   * - `'var(--accent-1)'`  — green
   * - `'var(--accent-2)'` — violet
   * - `'var(--accent-3)'`   — blue
   * - `'var(--accent-4)'` — warm orange
   */
  color: string
}

export interface StackedBarProps {
  segments: readonly StackedBarSegment[]
  /** Total capacity. Used to size both segments and the remaining gap. */
  total: number
  /**
   * Optional formatter for the legend value. Receives the segment value
   * and total — handy for "X / Y MB" or "X.X GB". Defaults to a plain
   * number with two-decimal "GB" units (`{value / 1024} GB`).
   */
  formatValue?: (value: number, total: number) => string
}

function defaultFormat(value: number): string {
  return `${(value / 1024).toFixed(2)} GB`
}

export function StackedBar({
  segments,
  total,
  formatValue = defaultFormat,
}: StackedBarProps) {
  const used = segments.reduce((s, x) => s + x.value, 0)
  const remaining = Math.max(0, total - used)

  return (
    <div className={styles.stack}>
      <div className={styles.stackBar}>
        {segments.map((s) => (
          <div
            key={s.label}
            className={styles.stackSeg}
            style={{
              background: s.color,
              width: `${(s.value / total) * 100}%`,
            }}
          />
        ))}
        {remaining > 0 && (
          <div
            className={styles.stackSeg}
            style={{
              background: 'var(--bg-surface)',
              width: `${(remaining / total) * 100}%`,
            }}
          />
        )}
      </div>
      <div className={styles.stackLegend}>
        {segments.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label} · {formatValue(s.value, total)}
          </span>
        ))}
      </div>
    </div>
  )
}
