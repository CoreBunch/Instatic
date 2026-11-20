/** Solid and gradient fill editor. In gradient mode the color controls edit the selected stop. */
import {
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { cn } from '@ui/cn'
import { useEvent } from '@ui/lib/useEvent'
import { createTrailingThrottle } from '@ui/lib/trailingThrottle'
import { TargetSolidIcon } from 'pixel-art-icons/icons/target-solid'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { isGradientImage } from '@ui/lib/cssValueList'
import { clamp } from '@ui/lib/clamp'
import {
  COLOR_FORMATS,
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
  reconcileStopSelection,
  type FillMode,
  type FillState,
} from './fillState'
import type { ColorVariable } from '@ui/lib/colorVariable'
import { TokenStylesSection } from './TokenStylesSection'
import { UnitStepperInput } from './UnitStepperInput'
import {
  beginDrag,
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

interface ColorPickerProps {
  /** Current colour (or gradient) in any notation the picker understands. */
  value: string
  /** Fires on every drag/commit with the value in the active notation. */
  onChange: (value: string) => void
  /** Offer the Solid / Linear / Radial fill tabs and emit gradient strings. */
  gradients?: boolean
  /** Site colour tokens offered in the searchable list. Omit to hide the list. */
  tokens?: readonly ColorVariable[]
  /** CSS custom-property name currently bound to the edited style. */
  assignedToken?: string
  /** Save the selected color in the site palette; returns the token to assign. */
  onSaveColor?: (name: string, color: string) => ColorVariable | null
}

type PickerVars = CSSProperties & {
  '--color-picker-hue'?: string
  '--color-picker-solid'?: string
  '--color-picker-x'?: string
  '--color-picker-y'?: string
  '--color-picker-swatch'?: string
  '--color-picker-gradient'?: string
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

/** Keep complex CSS editable without reducing it to a default solid or dropping gradient layers. */
function AuthoredColorInput({ value, gradients, tokens, assignedToken, onChange, onSaveColor }: ColorPickerProps) {
  const [draft, setDraft] = useState(value)
  const solid = window.CSS.supports('color', draft)
  const valid = solid
    || (gradients && isGradientImage(draft) && window.CSS.supports('background-image', draft))
  return <div className={styles.picker}>
    <Input aria-label={gradients ? "CSS color or gradient" : "CSS color"} value={draft} invalid={!valid}
    onChange={(event) => setDraft(event.target.value)}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
    onBlur={() => { if (valid && value !== draft.trim()) onChange(draft.trim()) }} />
    {solid && onSaveColor && <SaveColorForm onSave={(name) => {
      const token = onSaveColor(name, draft.trim())
      if (token) onChange(`var(${token.name})`)
      return Boolean(token)
    }} />}
    {solid && tokens && tokens.length > 0 && <TokenStylesSection assignedToken={assignedToken} tokens={tokens} onSelectToken={(token) => onChange(`var(${token.name})`)} />}
  </div>
}

export function ColorPicker({
  value,
  onChange,
  gradients = false,
  tokens,
  assignedToken,
  onSaveColor,
}: ColorPickerProps) {
  const [format, setFormat] = useState<ColorFormat>(() => detectFormat(value))
  const [parsedFill, setFill] = useState(() => initialFill(value, gradients, tokens))
  const [selectedStop, setSelectedStop] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)

  // Only an outstanding echo belongs to the current edit. Undo can revisit
  // any previously emitted color while the picker stays open.
  const [expectedEcho, setExpectedEcho] = useState<string | null>(null)
  const publish = useEvent((emitted: string) => {
    setExpectedEcho(emitted === value ? null : emitted)
    onChange(emitted)
  })
  const [throttle] = useState(() => createTrailingThrottle(publish, EMIT_THROTTLE_MS))
  useEffect(() => () => throttle.flush(), [throttle])

  const [lastValue, setLastValue] = useState(value)
  const [externalRevision, setExternalRevision] = useState(0)
  const [lastTokens, setLastTokens] = useState(tokens)
  if (tokens !== lastTokens) setLastTokens(tokens)
  const refreshStops = tokens !== lastTokens && gradients && value.includes('var(')
  if (lastValue !== value || refreshStops) {
    setLastValue(value)
    setExpectedEcho(null)
    if (expectedEcho !== value) {
      const next = initialFill(value, gradients, tokens)
      setFill(next)
      if (lastValue !== value) {
        setSelectedStop(reconcileStopSelection(parsedFill, next, selectedStop))
      }
      setDraft(null)
      setExternalRevision(externalRevision + 1)
    }
  }
  useLayoutEffect(() => throttle.cancel(), [externalRevision, throttle])

  if (!parsedFill) return <AuthoredColorInput key={value} value={value} gradients={gradients} tokens={tokens} assignedToken={assignedToken} onChange={onChange} onSaveColor={onSaveColor} />

  const fill = parsedFill
  // In a gradient mode the whole colour surface edits the selected stop.
  const stopIndex = Math.min(selectedStop, fill.stops.length - 1)
  const hsva = fill.mode === 'solid' ? fill.hsva : fill.stops[stopIndex].hsva

  const activeToken = fill.mode === 'solid' ? assignedToken : fill.stops[stopIndex].tokenName

  function assign(token: ColorVariable) {
    throttle.flush()
    const reference = `var(${token.name})`
    if (fill.mode === 'solid') {
      onChange(reference)
      return
    }
    const color = parseColor(token.value)
    const next = { ...fill, stops: fill.stops.map((stop, index) => index === stopIndex
      ? { ...stop, tokenName: token.name, hsva: color ? rgbaToHsva(color) : stop.hsva } : stop) }
    const css = formatFill(next, format)
    if (color) {
      setFill(next)
      publish(css)
    } else {
      // Preserve unsupported CSS colors in the authored gradient editor.
      onChange(css)
    }
  }

  const text = draft ?? formatColor(hsvaToRgba(hsva), format)
  const eyeDropperSupported =
    typeof window !== 'undefined' && typeof window.EyeDropper === 'function'

  function emit(nextFill: FillState, nextFormat = format) {
    setFill(nextFill)
    setDraft(null)
    const emitted = formatFill(nextFill, nextFormat)
    // Leading + trailing throttle: local picker state above is NOT throttled —
    // that is the optimistic half; only the heavy `onChange` rides the window.
    throttle.call(emitted)
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
          index === stopIndex ? { pos: stop.pos, hsva: next } : stop,
        ),
      },
      nextFormat,
    )
  }

  function handleFormatChange(next: ColorFormat) {
    setFormat(next)
    if (!activeToken) emit(fill, next)
  }

  function handleModeChange(nextMode: FillMode) {
    if (nextMode === fill.mode) return
    if (nextMode === 'solid') {
      // Collapse to the colour being edited so nothing visibly jumps.
      if (activeToken) {
        throttle.flush()
        onChange(`var(${activeToken})`)
      } else emit({ ...fill, mode: 'solid', hsva })
      return
    }
    if (fill.mode === 'solid') {
      // Seed a fresh gradient from the current colour: colour → transparent.
      setSelectedStop(0)
      const stops = defaultStops(fill.hsva)
      stops[0].tokenName = assignedToken
      emit({ ...fill, mode: nextMode, stops })
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
    if (event.button !== 0 || !event.isPrimary || rect.width === 0) return
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

    beginDrag(event, (pos) => {
      emit({
        ...fill,
        stops: baseStops.map((stop, i) => (i === index ? { ...stop, pos } : stop)),
      })
    })
  }

  function handleStopKey(event: KeyboardEvent<HTMLSpanElement>, index: number) {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      if (fill.stops.length <= 2) return
      const remaining = fill.stops.filter((_, i) => i !== index)
      const next = Math.min(index, remaining.length - 1)
      // The index-keyed handle survives unless the last stop was removed.
      if (next !== index) event.currentTarget.previousElementSibling?.closest<HTMLElement>('[role="slider"]')?.focus()
      setSelectedStop(next)
      emit({ ...fill, stops: remaining })
      return
    }
    if (event.key === 'Insert') {
      event.preventDefault()
      const positions = fill.stops.map((stop) => stop.pos).sort((a, b) => a - b)
      const start = fill.stops[index].pos
      const neighbor = positions.find((pos) => pos > start) ?? positions.findLast((pos) => pos < start) ?? 1
      const pos = (start + neighbor) / 2
      const color = gradientColorAt(fill.stops.map((stop) => ({ color: hsvaToRgba(stop.hsva), pos: stop.pos })), pos)
      setSelectedStop(fill.stops.length)
      emit({ ...fill, stops: [...fill.stops, { pos, hsva: rgbaToHsva(color) }] })
      const group = event.currentTarget.parentElement
      requestAnimationFrame(() => group?.querySelector<HTMLElement>('[role="slider"]:last-child')?.focus())
      return
    }
    handleTrackKeys(event, fill.stops[index].pos, (pos) =>
      emit({ ...fill, stops: fill.stops.map((stop, i) => i === index ? { ...stop, pos } : stop) }),
    )
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
      {gradients && (
        <SegmentedControl fullWidth size="xs" aria-label="Fill type"
          value={fill.mode} onChange={handleModeChange}
          options={GRADIENT_TABS.map((mode) => ({
            value: mode.value,
            ariaLabel: mode.label,
            tooltip: mode.label,
            icon: <span className={cn(styles.fillGlyph, styles[`fillGlyph-${mode.value}`])} aria-hidden="true" />,
          }))}
        />
      )}

      {fill.mode !== 'solid' && (
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
              role="slider"
              tabIndex={0}
              aria-label={`Fill stop ${index + 1} position`}
              aria-valuenow={Math.round(stop.pos * 100)}
              aria-valuetext={`${Math.round(stop.pos * 100)}%`}
              aria-keyshortcuts="Insert Delete"
              onFocus={() => setSelectedStop(index)}
              onKeyDown={(event) => handleStopKey(event, index)}
            />
          ))}
        </div>
      )}

      <div
        className={styles.saturation}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuenow={Math.round(hsva.s * 100)}
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

      {!activeToken && onSaveColor && <SaveColorForm onSave={(name) => {
        throttle.flush()
        const token = onSaveColor(name, formatColor(hsvaToRgba(hsva), 'hex'))
        if (token) assign(token)
        return Boolean(token)
      }} />}
      {tokens && tokens.length > 0 && (
        <TokenStylesSection assignedToken={activeToken} tokens={tokens} onSelectToken={assign} />
      )}
    </div>
  )
}

function SaveColorForm({ onSave }: { onSave: (name: string) => boolean }) {
  const [name, setName] = useState<string | null>(null)
  if (name === null) {
    return <Button size="xs" variant="secondary" onClick={() => setName('')}>Save to Framework</Button>
  }
  return <form className={styles.saveColor} onSubmit={(event) => {
    event.preventDefault()
    if (name.trim() && onSave(name.trim())) setName(null)
  }}>
    <Input autoFocus fieldSize="xs" value={name} aria-label="Framework color name"
      placeholder="Color name" onChange={(event) => setName(event.target.value)} />
    <Button variant="primary" size="xs" type="submit" disabled={!name.trim()}>Save</Button>
    <Button size="xs" variant="ghost" onClick={() => setName(null)}>Cancel</Button>
  </form>
}

/** Keep the picker in whatever notation the incoming value already uses. */
function detectFormat(value: string): ColorFormat {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('rgb') || trimmed.includes('rgb(') || trimmed.includes('rgba(')) return 'rgb'
  if (trimmed.startsWith('hsl') || trimmed.includes('hsl(') || trimmed.includes('hsla(')) return 'hsl'
  return 'hex'
}
