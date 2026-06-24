/**
 * Sparkline — pure-SVG line+area mini-chart.
 *
 * Used inside dashboard widgets (Visitors, Pageviews, custom analytics
 * plugins) to render a single time series in a constrained width. No
 * dependency on a charting library — the polyline + gradient area are
 * computed inline from the input array. Width is fluid (parent-driven);
 * height is fixed by the prop.
 *
 * The component is exposed to plugin authors via the plugin SDK so any
 * plugin (analytics, monitoring, etc.) can render a sparkline inside a
 * registered dashboard widget without bundling its own chart code.
 */
import { useId } from 'react'
import styles from './charts.module.css'

export interface SparklineProps {
  /** Numeric time series. Must contain at least 2 points. */
  data: readonly number[]
  /**
   * Stroke/fill colour. When omitted, falls back to the global
   * `--chart-default-tint` token (currently `var(--accent-4)`).
   * Unlike `Bars`, `Sparkline` does not auto-inherit an ambient `--tint`
   * from a parent widget — pass `tint='var(--tint)'` explicitly when
   * rendering inside host Widget chrome to pick up its accent colour.
   *
   * Recommended override values — use a design-system accent token:
   * - `'var(--accent-1)'`  — green
   * - `'var(--accent-2)'` — violet
   * - `'var(--accent-3)'`   — blue
   * - `'var(--accent-4)'` — warm orange
   */
  tint?: string
  /** Pixel height of the rendered chart. Default: 56. */
  height?: number
  /**
   * Optional aria-label. The svg is rendered as a presentation graphic
   * when omitted — appropriate for decorative repeats already labelled
   * by an adjacent stat number.
   */
  ariaLabel?: string
}

export function Sparkline({
  data,
  tint = 'var(--chart-default-tint)',
  height = 56,
  ariaLabel,
}: SparklineProps) {
  const gradId = useId()

  if (data.length < 2) {
    // A single point can't render a line. Fall back to an empty SVG so
    // layout doesn't shift while data is loading.
    return (
      <svg
        className={styles.sparkline}
        viewBox="0 0 300 56"
        preserveAspectRatio="none"
        role={ariaLabel ? 'img' : 'presentation'}
        aria-label={ariaLabel}
        style={{ ['--sparkline-h' as string]: `${height}px` }}
      />
    )
  }

  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = Math.max(1, max - min)
  const w = 300
  const h = height
  const stepX = w / (data.length - 1)
  const pts = data
    .map((v, i) => `${i * stepX},${h - ((v - min) / range) * (h - 6) - 3}`)
    .join(' ')
  const areaPts = `0,${h} ${pts} ${w},${h}`

  return (
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role={ariaLabel ? 'img' : 'presentation'}
      aria-label={ariaLabel}
      style={{ ['--sparkline-h' as string]: `${h}px` }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={tint} stopOpacity="0.35" />
          <stop offset="100%" stopColor={tint} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={areaPts} fill={`url(#${gradId})`} />
      <polyline
        points={pts}
        fill="none"
        stroke={tint}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
