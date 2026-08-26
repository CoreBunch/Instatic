/**
 * ColorPicker — the rich colour-editing surface behind every `ColorInput`.
 *
 * Saturation/brightness square, hue slider, alpha slider over a checkerboard,
 * a notation-aware text field (HEX / RGB / HSL), an opacity percentage field,
 * a native-`EyeDropper` screen picker (hidden where unsupported), and an
 * optional searchable list of the host site's colour tokens with a "New Style"
 * action that mints a token from the current colour.
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
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  BLACK,
  COLOR_FORMATS,
  clamp,
  formatColor,
  hsvaToRgba,
  hueCss,
  opaqueCss,
  parseColor,
  rgbaToHsva,
  safeCssColor,
  type ColorFormat,
  type Hsva,
} from './colorMath'
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
  /** Current colour, in any notation `parseColor` understands. */
  value: string
  /** Fires on every drag/commit with the colour in the active notation. */
  onChange: (value: string) => void
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
}

/** Arrow-key step, as a fraction of the track. Shift multiplies by 10. */
const KEY_STEP = 0.01

const FORMAT_LABELS: Record<ColorFormat, string> = {
  hex: 'HEX',
  rgb: 'RGB',
  hsl: 'HSL',
}

export function ColorPicker({
  value,
  onChange,
  tokens,
  onSelectToken,
  onCreateToken,
}: ColorPickerProps) {
  const [format, setFormat] = useState<ColorFormat>(() => detectFormat(value))
  const [hsva, setHsva] = useState<Hsva>(() => rgbaToHsva(parseColor(value) ?? BLACK))
  const [draft, setDraft] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [newTokenName, setNewTokenName] = useState<string | null>(null)

  // Adopt external value changes (undo, sibling edit, token pick) without
  // clobbering our own emissions — reparsing our own output would lose the hue
  // at zero saturation. Render-time previous-value comparison rather than a
  // useEffect+setState, matching the sibling colour fields.
  const [lastValue, setLastValue] = useState(value)
  const [lastEmitted, setLastEmitted] = useState<string | null>(null)
  if (lastValue !== value) {
    setLastValue(value)
    if (value !== lastEmitted) {
      setHsva(rgbaToHsva(parseColor(value) ?? BLACK))
      setDraft(null)
    }
  }

  const text = draft ?? formatColor(hsvaToRgba(hsva), format)
  const eyeDropperSupported =
    typeof window !== 'undefined' && typeof window.EyeDropper === 'function'
  const filteredTokens = filterTokens(tokens ?? [], search)

  function commit(next: Hsva, nextFormat = format) {
    setHsva(next)
    setDraft(null)
    const emitted = formatColor(hsvaToRgba(next), nextFormat)
    setLastEmitted(emitted)
    onChange(emitted)
  }

  function handleFormatChange(next: ColorFormat) {
    setFormat(next)
    commit(hsva, next)
  }

  function commitText() {
    if (draft === null) return
    const parsed = parseColor(draft)
    setDraft(null)
    if (parsed) commit(rgbaToHsva(parsed))
  }

  function handleAlphaText(raw: string) {
    const percent = Number.parseFloat(raw)
    if (!Number.isFinite(percent)) return
    commit({ ...hsva, a: clamp(percent / 100, 0, 1) })
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

  function submitNewToken() {
    const name = (newTokenName ?? '').trim()
    if (!name || !onCreateToken) return
    onCreateToken(name, formatColor(hsvaToRgba(hsva), format))
    setNewTokenName(null)
  }

  const surfaceStyle: PickerVars = {
    '--color-picker-hue': hueCss(hsva.h),
    '--color-picker-solid': opaqueCss(hsva),
  }

  return (
    <div className={styles.picker} style={surfaceStyle}>
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
            <PaintBucketSolidIcon size={12} aria-hidden="true" />
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
        <Input
          fieldSize="xs"
          type="number"
          min={0}
          max={100}
          step={1}
          unit="%"
          numberSpinner={false}
          value={Math.round(hsva.a * 100)}
          aria-label="Opacity percentage"
          className={styles.alphaInput}
          onChange={(event) => handleAlphaText(event.target.value)}
        />
      </div>

      {tokens && tokens.length > 0 && (
        <div className={styles.tokens}>
          <SearchBar
            value={search}
            onValueChange={setSearch}
            placeholder="Search styles"
            aria-label="Search colour styles"
          />
          <div className={styles.tokenList} role="listbox" aria-label="Colour styles">
            {filteredTokens.map((token) => (
              <Button
                key={token.key ?? token.name}
                variant="ghost"
                size="xs"
                menuItem
                align="start"
                role="option"
                aria-selected={false}
                className={styles.tokenRow}
                onClick={() => onSelectToken?.(`var(${token.name})`)}
              >
                <span
                  className={styles.tokenSwatch}
                  style={{ '--color-picker-swatch': safeCssColor(token.value) } as PickerVars}
                  aria-hidden="true"
                />
                <span className={styles.tokenName}>{token.name}</span>
                {token.meta && <span className={styles.tokenMeta}>{token.meta}</span>}
              </Button>
            ))}
            {filteredTokens.length === 0 && (
              <p className={styles.tokenEmpty}>No matching styles</p>
            )}
          </div>
        </div>
      )}

      {onCreateToken && (
        newTokenName === null ? (
          <Button
            variant="secondary"
            size="xs"
            fullWidth
            align="start"
            onClick={() => setNewTokenName('')}
          >
            <PlusIcon size={11} aria-hidden="true" />
            New Style
          </Button>
        ) : (
          <div className={styles.newStyle}>
            <Input
              fieldSize="xs"
              autoFocus
              prefix="--"
              value={newTokenName}
              aria-label="New style name"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setNewTokenName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitNewToken()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setNewTokenName(null)
                }
              }}
            />
            <Button
              variant="primary"
              size="xs"
              iconOnly
              aria-label="Create style"
              disabled={newTokenName.trim() === ''}
              onClick={submitNewToken}
            >
              <CheckIcon size={11} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label="Cancel new style"
              onClick={() => setNewTokenName(null)}
            >
              <CloseIcon size={10} aria-hidden="true" />
            </Button>
          </div>
        )
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------

/**
 * Drag within an element's own box. Pointer capture routes subsequent moves
 * back to the same element, so no window-level listeners are needed and the
 * drag survives leaving the element.
 */
function beginDrag(
  event: ReactPointerEvent<HTMLDivElement>,
  apply: (x: number, y: number) => void,
) {
  const element = event.currentTarget
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  element.setPointerCapture(event.pointerId)
  element.focus()

  const track = (clientX: number, clientY: number) => {
    apply(
      clamp((clientX - rect.left) / rect.width, 0, 1),
      clamp((clientY - rect.top) / rect.height, 0, 1),
    )
  }

  const handleMove = (move: PointerEvent) => track(move.clientX, move.clientY)
  const handleEnd = () => {
    element.removeEventListener('pointermove', handleMove)
    element.removeEventListener('pointerup', handleEnd)
    element.removeEventListener('pointercancel', handleEnd)
  }

  element.addEventListener('pointermove', handleMove)
  element.addEventListener('pointerup', handleEnd)
  element.addEventListener('pointercancel', handleEnd)
  track(event.clientX, event.clientY)
}

function handleTrackKeys(
  event: KeyboardEvent<HTMLDivElement>,
  current: number,
  apply: (next: number) => void,
) {
  const delta = event.shiftKey ? KEY_STEP * 10 : KEY_STEP
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault()
    apply(clamp(current - delta, 0, 1))
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault()
    apply(clamp(current + delta, 0, 1))
  } else if (event.key === 'Home') {
    event.preventDefault()
    apply(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    apply(1)
  }
}

function handleGridKeys(
  event: KeyboardEvent<HTMLDivElement>,
  hsva: Hsva,
  apply: (next: Hsva) => void,
) {
  const delta = event.shiftKey ? KEY_STEP * 10 : KEY_STEP
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    apply({ ...hsva, s: clamp(hsva.s - delta, 0, 1) })
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    apply({ ...hsva, s: clamp(hsva.s + delta, 0, 1) })
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    apply({ ...hsva, v: clamp(hsva.v + delta, 0, 1) })
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    apply({ ...hsva, v: clamp(hsva.v - delta, 0, 1) })
  }
}

function filterTokens(
  tokens: readonly ColorPickerToken[],
  search: string,
): ColorPickerToken[] {
  const query = search.trim().toLowerCase()
  if (!query) return [...tokens]
  return tokens.filter(
    (token) =>
      token.name.toLowerCase().includes(query) ||
      (token.meta?.toLowerCase().includes(query) ?? false),
  )
}

/** Keep the picker in whatever notation the incoming value already uses. */
function detectFormat(value: string): ColorFormat {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('rgb')) return 'rgb'
  if (trimmed.startsWith('hsl')) return 'hsl'
  return 'hex'
}
