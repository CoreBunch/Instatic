/**
 * LiquidProgressRing — circular progress badge filled with animated
 * liquid, complete with rising bubbles and a wavy surface. Tones: the
 * default toxic-green "mint", plus "amber" and "danger" palettes so score
 * displays can tier the liquid color.
 *
 * Composition (all inside one SVG, layered front-to-back):
 *
 *   1. Background disc — subtle radial sheen for the empty container glow.
 *   2. Clipping group `<g clip-path="url(...)">` so every animated shape
 *      stays inside the circular bottle:
 *      - Two overlapping wave paths (different speeds, opacities, tints)
 *        scroll horizontally via CSS `transform: translateX` for the
 *        moving-liquid surface effect.
 *      - 6 bubble circles spawn at the bottom and rise to the wave
 *        surface, scaling up and fading out as they "pop".
 *      - A faint highlight stripe sits on top of the wave for the
 *        glassy reflection.
 *   3. Outer ring outline — thin mint stroke marking the bottle edge.
 *   4. Centered fraction text — "value/total" sits over the liquid.
 *
 * The liquid surface height tracks `pct` (0..1): `surfaceY = 100 - 100*pct`
 * in the SVG's 0..100 user-unit grid. Bubbles read the same value via
 * a CSS custom property (`--rise-distance`) so they rise exactly to the
 * surface no matter the fill level.
 *
 * Reduced motion: when the user prefers reduced motion, the waves stop
 * scrolling, bubbles disappear, and the liquid renders as a static
 * shape at the right level. The progress data is still legible.
 */
import { useId, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './LiquidProgressRing.module.css'

export type LiquidProgressRingTone = 'mint' | 'amber' | 'danger'

export interface LiquidProgressRingProps {
  value: number
  total: number
  /** Pixel size of the ring. Defaults to 112. */
  size?: number
  /** Liquid palette. Defaults to 'mint'. */
  tone?: LiquidProgressRingTone
  /** Replaces the default "value/total" fraction in the center. */
  label?: ReactNode
  /** Defaults to "value of total steps complete". */
  ariaLabel?: string
}

/**
 * Per-tone gradient stops for the three liquid layers + the bottle ring.
 * SVG gradient stops can't read CSS custom properties reliably, so the
 * palettes live here as literals — same approach the original mint-only
 * palette used.
 */
const PALETTES: Record<LiquidProgressRingTone, {
  front: [string, string, string]
  back: [string, string]
  deep: [string, string, string]
  ring: string
}> = {
  mint: {
    front: ['rgba(167, 243, 208, 0.95)', 'rgba(142, 230, 200, 0.9)', 'rgba(52, 211, 153, 0.85)'],
    back: ['rgba(74, 222, 128, 0.45)', 'rgba(34, 197, 94, 0.4)'],
    deep: ['rgba(6, 95, 70, 0.9)', 'rgba(6, 78, 59, 0.85)', 'rgba(2, 44, 34, 0.85)'],
    ring: 'rgba(142, 230, 200, 0.55)',
  },
  amber: {
    front: ['rgba(253, 230, 138, 0.95)', 'rgba(252, 211, 77, 0.9)', 'rgba(245, 158, 11, 0.85)'],
    back: ['rgba(251, 191, 36, 0.45)', 'rgba(217, 119, 6, 0.4)'],
    deep: ['rgba(146, 64, 14, 0.9)', 'rgba(120, 53, 15, 0.85)', 'rgba(69, 26, 3, 0.85)'],
    ring: 'rgba(252, 211, 77, 0.55)',
  },
  danger: {
    front: ['rgba(254, 202, 202, 0.95)', 'rgba(252, 165, 165, 0.9)', 'rgba(239, 68, 68, 0.85)'],
    back: ['rgba(248, 113, 113, 0.45)', 'rgba(220, 38, 38, 0.4)'],
    deep: ['rgba(153, 27, 27, 0.9)', 'rgba(127, 29, 29, 0.85)', 'rgba(69, 10, 10, 0.85)'],
    ring: 'rgba(252, 165, 165, 0.55)',
  },
}

// SVG user-coordinate space — independent of the rendered pixel size.
const VIEW = 100
const STROKE = 4
const R = (VIEW - STROKE) / 2
const CX = VIEW / 2
const CY = VIEW / 2

// Wave geometry constants. The "front" + "back" parallax layers share
// the smaller wave shape; the "deep" layer uses bigger amplitude AND
// wavelength to read as a slower, larger-scale swell behind them.
//
// Wavelength matters not just visually — the CSS scroll animation
// translates each wave path by exactly one of its own wavelengths per
// loop, so the geometry has to match the keyframe distance for the
// motion to be seamless. The matching pairs:
//   front + back: 18 user-units per wavelength → translateX(-18px)
//   deep:         30 user-units per wavelength → translateX(-30px)
const WAVE_AMPLITUDE = 2.2
const WAVE_WAVELENGTH = 18
const DEEP_WAVE_AMPLITUDE = 4.2
const DEEP_WAVE_WAVELENGTH = 30

/**
 * Build a smooth sine-ish wave polygon that fills from `baseY` down to
 * y=100, ready for a fill rule. Uses quadratic Bezier segments with
 * the `T` (smooth-continuation) command, which alternates the implicit
 * control point above/below the baseline — that's exactly what we want
 * for a wave.
 *
 * Each path is built wider than the viewBox (by 2 wavelengths on both
 * sides) so the CSS-driven horizontal scroll never reveals the path's
 * end caps.
 */
function buildWavePath(
  baseY: number,
  amplitude: number = WAVE_AMPLITUDE,
  wavelength: number = WAVE_WAVELENGTH,
): string {
  const overrun = wavelength * 2
  const left = -overrun
  const right = VIEW + overrun
  // First Q seeds the implicit control point above the baseline so the
  // first reflected T dives below. Each subsequent T flips direction.
  let d = `M ${left} ${baseY} Q ${left + wavelength * 0.25} ${baseY - amplitude} ${left + wavelength * 0.5} ${baseY}`
  for (let x = left + wavelength * 0.5; x < right; x += wavelength * 0.5) {
    d += ` T ${x + wavelength * 0.5} ${baseY}`
  }
  d += ` L ${right} ${VIEW} L ${left} ${VIEW} Z`
  return d
}

interface BubbleSpec {
  cx: number
  r: number
  delay: number
  duration: number
}

/**
 * Hand-tuned bubble lineup — staggered across the bottle width with
 * different sizes and timings so the eye doesn't lock onto a periodic
 * pattern. Six bubbles strikes the balance between "lively" and "noisy
 * SVG repaint".
 */
const BUBBLES: readonly BubbleSpec[] = [
  { cx: 30, r: 2.2, delay: 0.0, duration: 3.0 },
  { cx: 42, r: 1.4, delay: 1.8, duration: 3.6 },
  { cx: 55, r: 2.6, delay: 0.9, duration: 3.4 },
  { cx: 64, r: 1.8, delay: 2.3, duration: 3.2 },
  { cx: 72, r: 1.2, delay: 0.4, duration: 3.8 },
  { cx: 48, r: 1.6, delay: 1.4, duration: 3.5 },
]

export function LiquidProgressRing({
  value,
  total,
  size = 112,
  tone = 'mint',
  label,
  ariaLabel,
}: LiquidProgressRingProps) {
  const palette = PALETTES[tone]
  const pct = total === 0 ? 0 : Math.max(0, Math.min(1, value / total))
  // Wave surface Y in user units. At pct=0 the surface is at the bottom
  // (y=100), at pct=1 it's at the top (y=0). Bubbles rise from y≈96
  // up to this surface line.
  const surfaceY = (1 - pct) * VIEW
  const wavePath = buildWavePath(surfaceY)
  const wavePathBack = buildWavePath(Math.min(VIEW, surfaceY + 1.4))
  // Deep wave shares the front wave's baseline but uses bigger amplitude
  // + wavelength + slower speed, so its taller crests periodically swell
  // up past the front wave's troughs as a darker silhouette — that's
  // the parallax-of-depth read.
  const wavePathDeep = buildWavePath(surfaceY, DEEP_WAVE_AMPLITUDE, DEEP_WAVE_WAVELENGTH)

  // Unique gradient / clip ids so multiple rings on the same page don't
  // collide. `useId` is React 18+ stable across server/client renders.
  const idBase = useId().replace(/:/g, '')
  const liquidGrad = `${idBase}-liquid`
  const liquidGradBack = `${idBase}-liquid-back`
  const liquidGradDeep = `${idBase}-liquid-deep`
  const ringClip = `${idBase}-clip`
  const innerGlow = `${idBase}-glow`

  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    // Bubbles read this CSS variable for their rise distance — the
    // exact pixel translation from spawn (y≈96) up to the live wave
    // surface, scaled into ring pixels. Recomputed at render so the
    // bubbles always reach the current liquid level.
    ['--rise-distance' as string]: `${((96 - surfaceY) / VIEW) * size}px`,
    ['--ring-size' as string]: `${size}px`,
  }

  return (
    <div
      className={cn(styles.ring, tone === 'amber' && styles.toneAmber, tone === 'danger' && styles.toneDanger)}
      style={containerStyle}
      role="img"
      aria-label={ariaLabel ?? `${value} of ${total} steps complete`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        aria-hidden="true"
        className={styles.svg}
      >
        <defs>
          {/* Bottle clip — every liquid / bubble pixel lives inside this. */}
          <clipPath id={ringClip}>
            <circle cx={CX} cy={CY} r={R} />
          </clipPath>

          {/* Primary liquid: a vertical gradient from a bright crest
              down to a slightly darker base for depth. */}
          <linearGradient id={liquidGrad} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={palette.front[0]} />
            <stop offset="55%" stopColor={palette.front[1]} />
            <stop offset="100%" stopColor={palette.front[2]} />
          </linearGradient>

          {/* Secondary back-wave — lower opacity for the parallax look. */}
          <linearGradient id={liquidGradBack} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={palette.back[0]} />
            <stop offset="100%" stopColor={palette.back[1]} />
          </linearGradient>

          {/* Deep wave — saturated dark tones for the "shadow of a
              deeper swell" effect. Higher opacity at the crest (where
              it peeks above the brighter front wave) so the parallax
              silhouette reads as a real shape, not just a tint. */}
          <linearGradient id={liquidGradDeep} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={palette.deep[0]} />
            <stop offset="55%" stopColor={palette.deep[1]} />
            <stop offset="100%" stopColor={palette.deep[2]} />
          </linearGradient>

          {/* Soft inner glow on the empty bottle. Pure white at low
              opacity so it reads as glass / sheen on dark backgrounds. */}
          <radialGradient id={innerGlow} cx="50%" cy="35%" r="65%">
            <stop offset="0%" stopColor="rgba(255, 255, 255, 0.06)" />
            <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
          </radialGradient>
        </defs>

        {/* Background "empty bottle" sheen. */}
        <circle cx={CX} cy={CY} r={R} fill={`url(#${innerGlow})`} />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke="rgba(255, 255, 255, 0.05)"
          strokeWidth={STROKE - 1}
        />

        <g clipPath={`url(#${ringClip})`}>
          {/* Deep wave (slowest + biggest + darkest). Sits behind every
              other liquid layer so its bigger crests periodically swell
              above the front wave's troughs, reading as a darker
              undertow / sea-floor silhouette through the lighter
              liquid above. */}
          <path
            d={wavePathDeep}
            fill={`url(#${liquidGradDeep})`}
            className={styles.waveDeep}
          />

          {/* Back wave (slower, more transparent — parallax depth). */}
          <path
            d={wavePathBack}
            fill={`url(#${liquidGradBack})`}
            className={styles.waveBack}
          />

          {/* Front wave (primary liquid body). */}
          <path
            d={wavePath}
            fill={`url(#${liquidGrad})`}
            className={styles.waveFront}
          />

          {/* Thin surface highlight — sits on the front wave's crest to
              suggest light catching the liquid's meniscus. */}
          <path
            d={wavePath}
            fill="none"
            stroke="rgba(255, 255, 255, 0.22)"
            strokeWidth="0.6"
            className={styles.waveFront}
          />

          {/* Rising bubbles. Each bubble spawns at y≈96 (just inside the
              bottom of the bottle) and rises to the wave surface, then
              pops (scale-up + fade-out). Bubbles are hidden when the
              bottle is essentially empty so they don't float in mid-air
              above the liquid surface. */}
          {pct > 0.05 && BUBBLES.map((bubble, i) => (
            <circle
              key={i}
              cx={bubble.cx}
              cy={96}
              r={bubble.r}
              fill="rgba(255, 255, 255, 0.7)"
              stroke="rgba(255, 255, 255, 0.4)"
              strokeWidth="0.3"
              className={styles.bubble}
              style={{
                animationDelay: `${bubble.delay}s`,
                animationDuration: `${bubble.duration}s`,
              }}
            />
          ))}
        </g>

        {/* Outer ring outline — sits over everything so the bottle
            silhouette stays crisp even when the wave is at full crest. */}
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke={palette.ring}
          strokeWidth={1.2}
        />
      </svg>

      <div className={styles.label}>
        {label ?? (
          <span className={styles.fraction}>
            {value}
            <small>/{total}</small>
          </span>
        )}
      </div>
    </div>
  )
}
