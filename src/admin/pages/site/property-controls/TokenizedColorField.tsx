import { useState, type CSSProperties, type ChangeEvent, type KeyboardEvent } from 'react'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { useEditorStore } from '@site/store/store'
import { ColorInput } from '@ui/components/ColorInput'
import { SwatchRow } from '@ui/components/SwatchRow'
import { parseGradient, type ColorPickerToken } from '@ui/components/ColorPicker'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { cn } from '@ui/cn'
import styles from './controls.module.css'

type ColorVariable = ReturnType<typeof generateFrameworkColorVariableSets>['light'][number]
type TokenSwatchStyle = CSSProperties & { '--color-token-option-value'?: string }

interface TokenizedColorFieldProps {
  id?: string
  value: string
  disabled?: boolean
  inputLabel: string
  swatchLabel: string
  placeholder?: string
  excludeTokenId?: string
  monospace?: boolean
  fieldSize?: 'xs' | 'sm' | 'md'
  /** Offer the picker's Solid / Linear / Radial / Conic fill tabs. */
  gradients?: boolean
  /**
   * Row presentation. `field` (default) is the swatch + typed value + token
   * suggestion menu — what the Colors panel needs to author token values.
   * `swatch` is the inspector's popout-trigger row: chip, the value's NAME,
   * and a clear cross; typing and the token list live inside the picker
   * popout instead, so every colour row in the panel reads identically.
   */
  look?: 'field' | 'swatch'
  /**
   * Forwarded to the swatch's ColorInput: inside a FloatingPanel (border /
   * effect popouts) the picker drills into that panel under this title
   * instead of stacking a second panel.
   */
  drillInTitle?: string
  onTextChange: (value: string) => void
  onTextBlur: () => void
  onSwatchChange: (value: string) => void
  onTokenSelect: (value: string) => void
  /**
   * Optional hover-preview hooks. When provided, hovering a colour-token
   * option fires `onTokenPreview` with its `var(--…)` reference; leaving the
   * row / closing the menu fires `onTokenPreviewClear`. The caller
   * (ColorControl) only passes these when the `hoverPreview` preference is on,
   * so this field stays preview-agnostic.
   */
  onTokenPreview?: (value: string) => void
  onTokenPreviewClear?: () => void
}

export function TokenizedColorField({
  id,
  value,
  disabled = false,
  inputLabel,
  swatchLabel,
  placeholder,
  excludeTokenId,
  monospace = false,
  fieldSize = 'sm',
  gradients = false,
  look = 'field',
  drillInTitle,
  onTextChange,
  onTextBlur,
  onSwatchChange,
  onTokenSelect,
  onTokenPreview,
  onTokenPreviewClear,
}: TokenizedColorFieldProps) {
  const colorSettings = useEditorStore((state) => state.site?.settings.framework?.colors)
  const createFrameworkColorToken = useEditorStore((state) => state.createFrameworkColorToken)
  const setGradientPickerOpen = useEditorStore((state) => state.setGradientPickerOpen)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const variables = generateFrameworkColorVariableSets(colorSettings).light
    .filter((variable) => variable.tokenId !== excludeTokenId)
  const filteredVariables = computeFilteredVariables(value, variables)
  const swatchValue = resolveTokenReferenceValue(value, variables) ?? value
  const pickerTokens: ColorPickerToken[] = variables.map((variable) => ({
    name: variable.name,
    value: variable.value,
    meta: variable.variantName,
    key: `${variable.tokenId}-${variable.variantId}`,
  }))
  const menuId = id ? `${id}-token-menu` : undefined
  const showMenu = open && !disabled && filteredVariables.length > 0

  // Reset the keyboard-highlight to the first option whenever `value` (and
  // therefore `filteredVariables`) changes. Done as a render-time
  // "previous-value" comparison rather than a useEffect+setState, so we
  // don't incur an extra render pass per keystroke.
  const [lastValue, setLastValue] = useState(value)
  if (lastValue !== value) {
    setLastValue(value)
    setActiveIndex(0)
  }

  function handleTextFocus() {
    if (!disabled) setOpen(true)
  }

  function handleTextBlur() {
    onTextBlur()
    onTokenPreviewClear?.()
    // Options prevent default on mousedown, so blur here always means focus
    // left the field — including onto the swatch, which now opens its own
    // picker popover and must not sit under a stale suggestion menu.
    window.setTimeout(() => setOpen(false), 0)
  }

  function handleTextChange(event: ChangeEvent<HTMLInputElement>) {
    onTextChange(event.target.value)
    setOpen(true)
  }

  function handleSwatchChange(nextValue: string) {
    onSwatchChange(nextValue)
    setOpen(false)
  }

  function handleTokenReference(reference: string) {
    onTokenPreviewClear?.()
    onTokenSelect(reference)
    setOpen(false)
  }

  /**
   * "New Style" in the picker mints a framework colour token from the current
   * colour and immediately binds the field to it, so the user never has to
   * detour through the Colors panel to promote a one-off colour.
   */
  function handleCreateToken(name: string, cssValue: string) {
    try {
      const token = createFrameworkColorToken({
        slug: name,
        lightValue: cssValue,
        darkModeEnabled: false,
      })
      handleTokenReference(`var(--${token.slug})`)
    } catch (err) {
      console.error('[TokenizedColorField] failed to create colour token:', err)
      pushToast({
        kind: 'error',
        title: 'Could not create style',
        body: getErrorMessage(err, 'Unknown colour token error'),
      })
    }
  }

  function commitToken(variable: ColorVariable) {
    onTokenPreviewClear?.()
    onTokenSelect(`var(${variable.name})`)
    setOpen(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!showMenu) {
      if (event.key === 'ArrowDown' && filteredVariables.length > 0) {
        event.preventDefault()
        setOpen(true)
      }
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      onTokenPreviewClear?.()
      setOpen(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, filteredVariables.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commitToken(filteredVariables[activeIndex])
    }
  }

  const swatch = (
    <ColorInput
      id={id ? `${id}-swatch` : undefined}
      value={swatchValue}
      swatchValue={swatchValue}
      disabled={disabled}
      gradients={gradients}
      // Only gradient-capable pickers drive the canvas gradient gizmo.
      onOpenChange={gradients ? setGradientPickerOpen : undefined}
      onValueChange={handleSwatchChange}
      tokens={pickerTokens}
      onSelectToken={handleTokenReference}
      onCreateToken={handleCreateToken}
      drillInTitle={drillInTitle}
      aria-label={swatchLabel}
      fieldSize="xs"
      className={styles.colorInlineSwatch}
    />
  )

  if (look === 'swatch') {
    const isSet = value.trim() !== ''
    return (
      <SwatchRow
        chip={swatch}
        name={colorValueName(value, variables)}
        isSet={isSet}
        onClear={isSet ? () => handleSwatchChange('') : undefined}
        clearLabel={`Remove ${inputLabel}`}
      />
    )
  }

  return (
    <div className={styles.colorRow}>
      <div className={styles.colorField} data-color-field="true">
        {swatch}
        <Input
          id={id}
          type="text"
          value={value}
          disabled={disabled}
          fieldSize={fieldSize}
          monospace={monospace}
          onFocus={handleTextFocus}
          onMouseDown={() => {
            if (!disabled) setOpen(true)
          }}
          onChange={handleTextChange}
          onBlur={handleTextBlur}
          onKeyDown={handleKeyDown}
          aria-label={inputLabel}
          aria-controls={showMenu ? menuId : undefined}
          aria-expanded={showMenu ? true : undefined}
          placeholder={placeholder}
          spellCheck={false}
          className={cn(styles.colorText, styles.colorTextWithPreview)}
        />
        {showMenu && (
          <div
            id={menuId}
            role="listbox"
            aria-label={`${inputLabel} color tokens`}
            className={styles.colorTokenMenu}
            onMouseLeave={() => onTokenPreviewClear?.()}
          >
            {filteredVariables.map((variable, index) => (
              <button
                key={`${variable.tokenId}-${variable.variantId}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={styles.colorTokenOption}
                onMouseEnter={() => {
                  setActiveIndex(index)
                  onTokenPreview?.(`var(${variable.name})`)
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commitToken(variable)}
              >
                <span
                  className={styles.colorTokenOptionSwatch}
                  style={{ '--color-token-option-value': variable.value } as TokenSwatchStyle}
                  aria-hidden="true"
                />
                <span className={styles.colorTokenOptionText}>
                  <span className={styles.colorTokenOptionName}>{variable.name}</span>
                  {variable.variantName && (
                    <span className={styles.colorTokenOptionMeta}>{variable.variantName}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function computeFilteredVariables(value: string, variables: ColorVariable[]): ColorVariable[] {
  const query = colorTokenSearchQuery(value)
  if (!query) return variables.slice(0, 32)
  return variables.filter((variable) => tokenVariableMatches(variable, query)).slice(0, 32)
}

function colorTokenSearchQuery(value: string): string {
  const trimmed = value.trim().toLowerCase()
  const variableMatch = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(trimmed)
  const tokenishValue = variableMatch?.[1] ?? trimmed
  if (tokenishValue.startsWith('--')) return tokenishValue.slice(2)
  if (/^[a-z0-9_-]+$/.test(tokenishValue)) return tokenishValue
  return ''
}

function tokenVariableMatches(variable: ColorVariable, query: string): boolean {
  const name = variable.name.slice(2).toLowerCase()
  return name.includes(query) ||
    variable.slug.toLowerCase().includes(query) ||
    (variable.variantName?.toLowerCase().includes(query) ?? false)
}

/**
 * What the swatch row shows next to the chip — the value's NAME, never its
 * raw CSS: a token's slug, the gradient kind, "Image" for a `url(…)` source,
 * and a bare uppercase hex for a one-off colour.
 */
function colorValueName(value: string, variables: ColorVariable[]): string {
  const trimmed = value.trim()
  if (trimmed === '') return 'Add…'

  const variableName = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(trimmed)?.[1]
  if (variableName) {
    const slug = variables.find((variable) => variable.name === variableName)?.slug
    if (slug) return slug.charAt(0).toUpperCase() + slug.slice(1)
    return variableName
  }

  if (/^\s*url\(/i.test(trimmed)) return 'Image'

  const gradient = parseGradient(trimmed)
  if (gradient) return gradient.kind.charAt(0).toUpperCase() + gradient.kind.slice(1)

  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed)
  return hex ? hex[1].toUpperCase() : trimmed
}

function resolveTokenReferenceValue(value: string, variables: ColorVariable[]): string | null {
  const variableName = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(value.trim())?.[1]
  if (!variableName) return null
  return variables.find((variable) => variable.name === variableName)?.value ?? null
}
