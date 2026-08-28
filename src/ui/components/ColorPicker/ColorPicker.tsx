/**
 * ColorPicker — the rich colour-editing surface behind every `ColorInput`.
 *
 * Saturation/brightness square, hue slider, alpha slider over a checkerboard,
 * a notation-aware text field (HEX / RGB / HSL), an opacity percentage field,
 * a native-`EyeDropper` screen picker (hidden where unsupported), and an
 * optional searchable list of the host site's colour tokens with a "New Style"
 * action that mints a token from the current colour.
 *
 * With `gradients` enabled the picker grows a fill-type icon row (Solid /
 * Linear / Radial / Conic) and a stop strip; `images` adds one more tab so a
 * background fill can be an image picked in the SAME surface as its colours. In a gradient mode the whole solid-colour surface
 * edits the SELECTED stop: click the strip to add a stop, drag a handle to
 * move it, double-click to remove it. The emitted value is then a CSS
 * gradient string instead of a single colour.
 *
 * The component is deliberately store-agnostic: tokens and token creation
 * arrive as props so `src/ui/` stays free of editor/state imports. The site
 * editor supplies them from `TokenizedColorField`.
 *
 * Every gradient is driven by inline CSS custom properties (the one permitted
 * inline-style form) so the stylesheet keeps sourcing its static colours from
 * `globals.css` tokens.
 */

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { cn } from '@ui/cn'
import { TargetSolidIcon } from 'pixel-art-icons/icons/target-solid'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  COLOR_FORMATS,
  clamp,
  formatColor,
  hsvaToRgba,
  hueCss,
  opaqueCss,
  parseColor,
  rgbaToHsva,
  type ColorFormat,
  type Hsva,
} from './colorMath'
import { formatGradient, gradientColorAt } from './gradientMath'
import {
  defaultStops,
  formatFill,
  initialFill,
  nearestStop,
  type FillMode,
  type ImagePosition,
  type ImageType,
  type FillState,
} from './fillState'
import { TokenStylesSection } from './TokenStylesSection'
import { UnitStepperInput } from './UnitStepperInput'
import {
  beginDrag,
  createEmitThrottle,
  frameThrottle,
  handleGridKeys,
  handleTrackKeys,
} from './interaction'
import styles from './ColorPicker.module.css'

interface EyeDropperResult {
  sRGBHex: string
}

interface EyeDropperInstance {
  open: (options?: { signal?: AbortSignal }) => Promise<EyeDropperResult>
}

type EyeDropperConstructor = new () => EyeDropperInstance

declare global {
  interface Window {
    EyeDropper?: EyeDropperConstructor
  }
}

export interface ColorPickerToken {
  /** The CSS custom-property name, including the leading `--`. */
  name: string
  /** The resolved colour the swatch previews. */
  value: string
  /** Optional secondary label (e.g. a variant name). */
  meta?: string
  /** Stable list key when several tokens share a name. */
  key?: string
}

interface ColorPickerProps {
  /** Current colour (or gradient) in any notation the picker understands. */
  value: string
  /** Fires on every drag/commit with the value in the active notation. */
  onChange: (value: string) => void
  /** Offer the Solid / Linear / Radial fill tabs and emit gradient strings. */
  gradients?: boolean
  /** Offer the Image fill tab — for background fills, not colour-only fields. */
  images?: boolean
  /** Opens the host's media library. Without it the Choose button is inert. */
  onPickImage?: () => void
  /** Site colour tokens offered in the searchable list. Omit to hide the list. */
  tokens?: readonly ColorPickerToken[]
  /** Fires when a token row is picked, with its `var(--name)` reference. */
  onSelectToken?: (reference: string) => void
  /** Enables the "New Style" action. Receives the token name and current colour. */
  onCreateToken?: (name: string, value: string) => void
}

type PickerVars = CSSProperties & {
  '--color-picker-hue'?: string
  '--color-picker-solid'?: string
  '--color-picker-x'?: string
  '--color-picker-y'?: string
  '--color-picker-swatch'?: string
  '--color-picker-gradient'?: string
  '--color-picker-image'?: string
  '--color-picker-image-size'?: string
  '--color-picker-image-repeat'?: string
  '--color-picker-image-position'?: string
}

/** Pointer distance (px) within which a strip press grabs an existing stop. */
const STOP_GRAB_PX = 12

/**
 * Trailing-throttle window for `onChange` during drags. The downstream cost
 * of one emission is a store commit + CRDT op + live canvas repaint — far
 * heavier than the picker's own render — so it runs at ~15 Hz while the
 * picker itself stays at full frame rate.
 */
const EMIT_THROTTLE_MS = 64

const FORMAT_LABELS: Record<ColorFormat, string> = {
  hex: 'HEX',
  rgb: 'RGB',
  hsl: 'HSL',
}

const GRADIENT_TABS: ReadonlyArray<{ value: FillMode; label: string }> = [
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Linear gradient' },
  { value: 'radial', label: 'Radial gradient' },
  { value: 'conic', label: 'Conic gradient' },
]

const IMAGE_TAB: { value: FillMode; label: string } = { value: 'image', label: 'Image' }

const IMAGE_TYPES: ReadonlyArray<{ value: ImageType; label: string }> = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'tile', label: 'Tile' },
]

/** The 3×3 anchor grid, in reading order. */
const IMAGE_POSITIONS: ReadonlyArray<{ value: ImagePosition; label: string }> = [
  { value: 'left top', label: 'Top left' },
  { value: 'center top', label: 'Top' },
  { value: 'right top', label: 'Top right' },
  { value: 'left center', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right center', label: 'Right' },
  { value: 'left bottom', label: 'Bottom left' },
  { value: 'center bottom', label: 'Bottom' },
  { value: 'right bottom', label: 'Bottom right' },
]

/** How each Type paints the preview — and, later, the emitted CSS. */
const IMAGE_TYPE_CSS: Record<ImageType, { size: string; repeat: string }> = {
  fill: { size: 'cover', repeat: 'no-repeat' },
  fit: { size: 'contain', repeat: 'no-repeat' },
  stretch: { size: '100% 100%', repeat: 'no-repeat' },
  tile: { size: 'auto', repeat: 'repeat' },
}

export function ColorPicker({
  value,
  onChange,
  gradients = false,
  images = false,
  onPickImage,
  tokens,
  onSelectToken,
  onCreateToken,
}: ColorPickerProps) {
  const [format, setFormat] = useState<ColorFormat>(() => detectFormat(value))
  const [fill, setFill] = useState<FillState>(() => initialFill(value, gradients, images))
  const [selectedStop, setSelectedStop] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)

  // The picker is OPTIMISTIC: local state (the handles, the strip, the text
  // fields) updates on every frame, while `onChange` — which drives the
  // editor store, the CRDT and a live canvas repaint — is trailing-throttled.
  // Emissions echoed back as `value` are recognised via `recentEmits`
  // (a small capped list, not a single last-emitted string), because with a
  // throttle in play the echo can be any of the last few emissions, and
  // treating an intermediate echo as external input would snap the drag back.
  const [recentEmits, setRecentEmits] = useState<string[]>([])
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  const emitThrottleRef = useRef<ReturnType<typeof createEmitThrottle> | null>(null)
  // Created in an effect (not render) so the ref is never read during render.
  // Event handlers only run after mount, so the throttle always exists by the
  // time emit() fires. The cleanup flushes a pending trailing emission so the
  // final drag position is never lost when the panel closes mid-window.
  useEffect(() => {
    const throttle = createEmitThrottle(EMIT_THROTTLE_MS, (emitted) => onChangeRef.current(emitted))
    emitThrottleRef.current = throttle
    return () => {
      throttle.flush()
      emitThrottleRef.current = null
    }
  }, [])

  // Adopt external value changes (undo, sibling edit, token pick) without
  // clobbering our own emissions — reparsing our own output would lose the hue
  // at zero saturation. Render-time previous-value comparison rather than a
  // useEffect+setState, matching the sibling colour fields.
  const [lastValue, setLastValue] = useState(value)
  if (lastValue !== value) {
    setLastValue(value)
    if (!recentEmits.includes(value)) {
      setFill(initialFill(value, gradients, images))
      setSelectedStop(0)
      setDraft(null)
    }
  }

  const isImage = fill.mode === 'image'
  // One tab row for both capabilities: gradient arms only when `gradients`,
  // the image arm only when `images`. A single tab is no choice, so hide it.
  const fillTabs = [
    ...(gradients ? GRADIENT_TABS : images ? [GRADIENT_TABS[0]] : []),
    ...(images ? [IMAGE_TAB] : []),
  ]

  // In a gradient mode the whole colour surface edits the selected stop.
  const stopIndex = Math.min(selectedStop, fill.stops.length - 1)
  const hsva = fill.mode === 'solid' ? fill.hsva : fill.stops[stopIndex].hsva

  const text = draft ?? formatColor(hsvaToRgba(hsva), format)
  const eyeDropperSupported =
    typeof window !== 'undefined' && typeof window.EyeDropper === 'function'

  // Latest colour for "New Style", read at click time via a ref so the token
  // section's props stay referentially stable across drag frames.
  const currentColorRef = useRef('')
  useEffect(() => {
    currentColorRef.current = formatColor(hsvaToRgba(hsva), format)
  })

  function emit(nextFill: FillState, nextFormat = format) {
    setFill(nextFill)
    setDraft(null)
    const emitted = formatFill(nextFill, nextFormat)
    setRecentEmits((current) => [...current.slice(-31), emitted])
    // Leading + trailing throttle: local picker state above is NOT throttled —
    // that is the optimistic half; only the heavy `onChange` rides the window.
    emitThrottleRef.current?.push(emitted)
  }

  /** Route a colour edit to the solid colour or the selected gradient stop. */
  function commit(next: Hsva, nextFormat = format) {
    if (fill.mode === 'solid') {
      emit({ ...fill, hsva: next }, nextFormat)
      return
    }
    emit(
      {
        ...fill,
        stops: fill.stops.map((stop, index) =>
          index === stopIndex ? { ...stop, hsva: next } : stop,
        ),
      },
      nextFormat,
    )
  }

  function handleFormatChange(next: ColorFormat) {
    setFormat(next)
    emit(fill, next)
  }

  function handleModeChange(nextMode: FillMode) {
    if (nextMode === fill.mode) return
    if (nextMode === 'image') {
      // With no source yet there is nothing to emit — opening the tab must not
      // wipe the fill the element already has. The value lands on the pick.
      if (fill.image.url) emit({ ...fill, mode: nextMode })
      else setFill({ ...fill, mode: nextMode })
      return
    }
    if (nextMode === 'solid') {
      // Collapse to the colour being edited so nothing visibly jumps.
      emit({ ...fill, mode: 'solid', hsva })
      return
    }
    if (fill.mode === 'solid') {
      // Seed a fresh gradient from the current colour: colour → transparent.
      setSelectedStop(0)
      emit({ ...fill, mode: nextMode, stops: defaultStops(fill.hsva) })
      return
    }
    emit({ ...fill, mode: nextMode })
  }

  function commitText() {
    if (draft === null) return
    const parsed = parseColor(draft)
    setDraft(null)
    if (parsed) commit(rgbaToHsva(parsed))
  }




  async function pickFromScreen() {
    const EyeDropperCtor = window.EyeDropper
    if (!EyeDropperCtor) return
    try {
      const result = await new EyeDropperCtor().open()
      const parsed = parseColor(result.sRGBHex)
      if (parsed) commit({ ...rgbaToHsva(parsed), a: hsva.a })
    } catch (err) {
      // Dismissing the eyedropper rejects with AbortError — not a failure.
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.error('[ColorPicker] eyedropper failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not pick a colour',
        body: getErrorMessage(err, 'Unknown eyedropper error'),
      })
    }
  }

  /**
   * Strip press: grab the nearest stop when one is close enough, otherwise
   * mint a new stop with the gradient's own colour at that position. Either
   * way the pressed stop is selected and follows the pointer.
   */
  function handleStripPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    if (rect.width === 0) return
    const at = clamp((event.clientX - rect.left) / rect.width, 0, 1)

    let baseStops = fill.stops
    let index = nearestStop(fill.stops, at)
    if (index === -1 || Math.abs(fill.stops[index].pos - at) * rect.width > STOP_GRAB_PX) {
      const color = gradientColorAt(
        fill.stops.map((stop) => ({ color: hsvaToRgba(stop.hsva), pos: stop.pos })),
        at,
      )
      baseStops = [...fill.stops, { hsva: rgbaToHsva(color), pos: at }]
      index = baseStops.length - 1
    }
    setSelectedStop(index)

    const applyAt = (clientX: number) => {
      const pos = clamp((clientX - rect.left) / rect.width, 0, 1)
      emit({
        ...fill,
        stops: baseStops.map((stop, i) => (i === index ? { ...stop, pos } : stop)),
      })
    }

    element.setPointerCapture(event.pointerId)
    // Frame-throttled like every other picker drag — see interaction.ts.
    const throttled = frameThrottle<number>(applyAt)
    const handleMove = (move: PointerEvent) => throttled.push(move.clientX)
    const handleEnd = () => {
      element.removeEventListener('pointermove', handleMove)
      element.removeEventListener('pointerup', handleEnd)
      element.removeEventListener('pointercancel', handleEnd)
      throttled.flush()
    }
    element.addEventListener('pointermove', handleMove)
    element.addEventListener('pointerup', handleEnd)
    element.addEventListener('pointercancel', handleEnd)
    applyAt(event.clientX)
  }

  /** Double-click removes the pressed stop — a gradient keeps at least two. */
  function handleStripDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (fill.stops.length <= 2) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const at = clamp((event.clientX - rect.left) / rect.width, 0, 1)
    const index = nearestStop(fill.stops, at)
    if (index === -1 || Math.abs(fill.stops[index].pos - at) * rect.width > STOP_GRAB_PX) return
    setSelectedStop(0)
    emit({ ...fill, stops: fill.stops.filter((_, i) => i !== index) })
  }


  const surfaceStyle: PickerVars = {
    '--color-picker-hue': hueCss(hsva.h),
    '--color-picker-solid': opaqueCss(hsva),
  }
  // The strip previews the stops on a horizontal line regardless of the fill
  // kind — canonical output of formatGradient, so safe to inline.
  const stripCss = formatGradient(
    {
      kind: 'linear',
      angle: 90,
      stops: fill.stops.map((stop) => ({ color: hsvaToRgba(stop.hsva), pos: stop.pos })),
    },
    'hex',
  )

  return (
    <div className={styles.picker} style={surfaceStyle}>
      {fillTabs.length > 1 && (
        <div className={styles.fillTabs} role="group" aria-label="Fill type">
          {fillTabs.map((mode, index) => (
            <Fragment key={mode.value}>
              {index > 0 && <span className={styles.fillTabSeparator} aria-hidden="true" />}
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                aria-label={mode.label}
                aria-pressed={fill.mode === mode.value}
                tooltip={mode.label}
                className={cn(
                  styles.fillTab,
                  fill.mode === mode.value && styles.fillTabActive,
                )}
                onClick={() => handleModeChange(mode.value)}
              >
                <span
                  className={cn(styles.fillGlyph, styles[`fillGlyph-${mode.value}`])}
                  aria-hidden="true"
                />
              </Button>
            </Fragment>
          ))}
        </div>
      )}

      {isImage && (
        <div className={styles.imagePane}>
          <div
            className={styles.imageStage}
            data-empty={fill.image.url ? undefined : 'true'}
            style={
              {
                '--color-picker-image': fill.image.url
                  ? `url("${fill.image.url}")`
                  : 'none',
                '--color-picker-image-size': IMAGE_TYPE_CSS[fill.image.type].size,
                '--color-picker-image-repeat': IMAGE_TYPE_CSS[fill.image.type].repeat,
                '--color-picker-image-position': fill.image.position,
              } as PickerVars
            }
          >
            <Button
              variant="secondary"
              size="sm"
              disabled={onPickImage == null}
              onClick={onPickImage}
            >
              {fill.image.url ? 'Replace Image…' : 'Choose Image…'}
            </Button>
          </div>

          {/* ponytail: Type and Position move picker-local state only — they
              belong on `background-size` / `-repeat` / `-position`, which this
              picker does not own yet. Tracked in the inspector-redesign TODO. */}
          <div className={styles.imageRow}>
            <span className={styles.imageLabel}>Type</span>
            <Select
              fieldSize="xs"
              value={fill.image.type}
              aria-label="Image type"
              onChange={(event) =>
                setFill({
                  ...fill,
                  image: { ...fill.image, type: event.target.value as ImageType },
                })
              }
            >
              {IMAGE_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </Select>
          </div>

          <div className={styles.imageRow}>
            <span className={styles.imageLabel}>Position</span>
            <div className={styles.imagePosition}>
              <div className={styles.positionGrid} role="group" aria-label="Image position">
                {IMAGE_POSITIONS.map((anchor) => (
                  <Button
                    key={anchor.value}
                    variant="ghost"
                    size="micro"
                    iconOnly
                    className={styles.positionCell}
                    aria-label={anchor.label}
                    aria-pressed={fill.image.position === anchor.value}
                    onClick={() =>
                      setFill({ ...fill, image: { ...fill.image, position: anchor.value } })
                    }
                  >
                    <span className={styles.positionDot} aria-hidden="true" />
                  </Button>
                ))}
              </div>
              <span className={styles.positionName}>
                {IMAGE_POSITIONS.find((a) => a.value === fill.image.position)?.label}
              </span>
            </div>
          </div>
        </div>
      )}

      {fill.mode !== 'solid' && !isImage && (
        <div
          className={styles.stops}
          role="group"
          aria-label="Gradient stops"
          style={{ '--color-picker-gradient': stripCss } as PickerVars}
          onPointerDown={handleStripPointerDown}
          onDoubleClick={handleStripDoubleClick}
        >
          <span className={styles.stopsFill} aria-hidden="true" />
          {fill.stops.map((stop, index) => (
            <span
              key={index}
              className={
                index === stopIndex
                  ? `${styles.stopHandle} ${styles.stopHandleSelected}`
                  : styles.stopHandle
              }
              style={
                {
                  '--color-picker-x': `${stop.pos * 100}%`,
                  '--color-picker-swatch': formatColor(hsvaToRgba(stop.hsva), 'hex'),
                } as PickerVars
              }
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {!isImage && (
        <>
      <div
        className={styles.saturation}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(hsva.s * 100)}%, brightness ${Math.round(hsva.v * 100)}%`}
        onPointerDown={(event) =>
          beginDrag(event, (x, y) => commit({ ...hsva, s: x, v: 1 - y }))
        }
        onKeyDown={(event) =>
          handleGridKeys(event, hsva, (next) => commit(next))
        }
      >
        <span
          className={styles.saturationHandle}
          style={
            {
              '--color-picker-x': `${hsva.s * 100}%`,
              '--color-picker-y': `${(1 - hsva.v) * 100}%`,
            } as PickerVars
          }
          aria-hidden="true"
        />
      </div>

      <div className={styles.sliderRow}>
        {eyeDropperSupported && (
          <Button
            variant="secondary"
            size="sm"
            iconOnly
            aria-label="Pick a colour from the screen"
            tooltip="Pick from screen"
            onClick={pickFromScreen}
          >
            <TargetSolidIcon size={12} aria-hidden="true" />
          </Button>
        )}
        <div className={styles.tracks}>
          <div
            className={styles.hue}
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsva.h)}
            onPointerDown={(event) =>
              beginDrag(event, (x) => commit({ ...hsva, h: x * 360 }))
            }
            onKeyDown={(event) =>
              handleTrackKeys(event, hsva.h / 360, (next) =>
                commit({ ...hsva, h: next * 360 }),
              )
            }
          >
            <span
              className={styles.trackHandle}
              style={{ '--color-picker-x': `${(hsva.h / 360) * 100}%` } as PickerVars}
              aria-hidden="true"
            />
          </div>
          <div
            className={styles.alpha}
            role="slider"
            tabIndex={0}
            aria-label="Opacity"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsva.a * 100)}
            onPointerDown={(event) => beginDrag(event, (x) => commit({ ...hsva, a: x }))}
            onKeyDown={(event) =>
              handleTrackKeys(event, hsva.a, (next) => commit({ ...hsva, a: next }))
            }
          >
            <span className={styles.alphaFill} aria-hidden="true" />
            <span
              className={styles.trackHandle}
              style={{ '--color-picker-x': `${hsva.a * 100}%` } as PickerVars}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      <SegmentedControl
        size="xs"
        fullWidth
        value={format}
        aria-label="Colour notation"
        options={COLOR_FORMATS.map((candidate) => ({
          value: candidate,
          label: FORMAT_LABELS[candidate],
        }))}
        onChange={handleFormatChange}
      />

      <div className={styles.fields}>
        <Input
          fieldSize="xs"
          monospace
          spellCheck={false}
          value={text}
          aria-label={`Colour value (${FORMAT_LABELS[format]})`}
          className={styles.valueInput}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitText()
            }
          }}
        />
        <UnitStepperInput
          value={hsva.a * 100}
          unit="%"
          min={0}
          max={100}
          ariaLabel="Opacity percentage"
          onCommit={(percent) => commit({ ...hsva, a: percent / 100 })}
        />
      </div>

      {(fill.mode === 'linear' || fill.mode === 'conic') && (
        <div className={styles.angleRow}>
          <span className={styles.angleLabel}>Angle</span>
          <UnitStepperInput
            value={fill.angle}
            unit="deg"
            min={0}
            max={360}
            ariaLabel="Gradient angle in degrees"
            onCommit={(degrees) => emit({ ...fill, angle: degrees })}
          />
        </div>
      )}

      {/*
        The section reads the CURRENT colour through a ref at click time, not
        through a prop: a `currentColor` prop would change on every drag frame
        and re-render the (potentially 100+ row) token list each time —
        keeping its props referentially stable lets the compiler skip it.
      */}
      <TokenStylesSection
        tokens={tokens ?? []}
        onSelectToken={onSelectToken}
        onCreateStyle={
          onCreateToken
            ? (name) => onCreateToken(name, currentColorRef.current)
            : undefined
        }
      />
        </>
      )}
    </div>
  )
}

/** Keep the picker in whatever notation the incoming value already uses. */
function detectFormat(value: string): ColorFormat {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('rgb') || trimmed.includes('rgb(') || trimmed.includes('rgba(')) return 'rgb'
  if (trimmed.startsWith('hsl') || trimmed.includes('hsl(') || trimmed.includes('hsla(')) return 'hsl'
  return 'hex'
}
