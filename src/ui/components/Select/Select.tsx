import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from 'react'
import { ChevronDown2Icon } from 'pixel-art-icons/icons/chevron-down-2'
import { cn } from '@ui/cn'
import styles from './Select.module.css'
import {
  getInitialActiveIndex,
  getOptionId,
  hasTextValue,
  isEnabledOptionIndex,
  normalizeOptions,
  type SelectOption,
} from './SelectOption'
import { useSelectMenuAnchor, type MenuPlacement } from './useSelectMenuAnchor'
import { useSelectValue } from './useSelectValue'
import { handleSelectKeyDown } from './selectKeyboard'
import { SelectMenu } from './SelectMenu'

type FieldSize = 'xs' | 'sm' | 'md'
type TextEmphasis = 'default' | 'strong'

/**
 * Default cap for the open dropdown's height. ~11 rows at the 28px item
 * height — tall enough to feel roomy, short enough that long lists (e.g. the
 * 300+ OpenRouter model list) scroll instead of running off the screen.
 */
const DEFAULT_MENU_MAX_HEIGHT = 320

/**
 * Auto-enable the in-menu search box once the option count exceeds this.
 * Below it, a list is short enough to scan without filtering.
 */
const SEARCH_THRESHOLD = 8

/**
 * Keys the in-menu search box forwards to list navigation. Everything else
 * (including Space) types into the box, so model names with spaces filter
 * correctly. Home/End are intentionally absent — they move the text caret.
 */
const SEARCH_NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'])

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  invalid?: boolean
  fieldSize?: FieldSize
  emphasis?: TextEmphasis
  menuMinWidth?: number
  /**
   * Maximum height of the open dropdown in pixels. When the options exceed
   * this, the menu becomes vertically scrollable and is clamped to the
   * viewport (`min(menuMaxHeight, 100vh - 16px)`). Defaults to
   * {@link DEFAULT_MENU_MAX_HEIGHT} so long lists (e.g. 300+ AI models) never
   * run off-screen.
   */
  menuMaxHeight?: number
  /**
   * Controls the in-menu search box that filters options as you type.
   *   - `undefined` (default): auto-enabled once the option count exceeds
   *     {@link SEARCH_THRESHOLD}.
   *   - `true` / `false`: force the search box on or off regardless of count.
   */
  searchable?: boolean
  /** Placeholder shown in the in-menu search box. Default: `'Search…'`. */
  searchPlaceholder?: string
  menuPlacement?: MenuPlacement
  /**
   * Optional element whose bounding rect provides the dropdown's horizontal
   * anchor (left edge + width). When unset, the trigger's own rect is used.
   *
   * Useful when the trigger is a narrow cell in a multi-column layout but the
   * option labels are too long to fit the cell — the dropdown can span a
   * wider parent (e.g. the full grid row) so labels stay fully readable
   * instead of being truncated to the cell width.
   *
   * Vertical positioning still anchors to the trigger so the menu opens just
   * below it; only the `x` and `width` come from the anchor element.
   *
   * Ignored when `menuPlacement === 'left-start'` (left-anchored placement
   * needs trigger-relative coordinates to stay aligned with the trigger row).
   */
  menuAnchorRef?: React.RefObject<HTMLElement | null>
  options?: SelectOption[]
  placeholder?: string
  /**
   * Optional hover-preview hook. Fired with an option's value while the
   * pointer is over its row in the open dropdown, so callers can transiently
   * apply the value (e.g. preview a CSS value on the canvas) without
   * committing. `onOptionPreviewClear` fires when the menu closes (commit,
   * dismiss, or escape) so the caller can tear the preview down.
   */
  onOptionPreview?: (value: string) => void
  onOptionPreviewClear?: () => void
  'data-testid'?: string
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLSelectElement>
}

export function Select({
  className,
  invalid = false,
  fieldSize = 'md',
  emphasis = 'default',
  options,
  children,
  disabled = false,
  value,
  defaultValue,
  onChange,
  onOptionPreview,
  onOptionPreviewClear,
  id,
  name,
  required,
  placeholder,
  menuMinWidth,
  menuMaxHeight = DEFAULT_MENU_MAX_HEIGHT,
  searchable,
  searchPlaceholder = 'Search…',
  menuPlacement = 'bottom-start',
  menuAnchorRef,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': dataTestId,
  ref,
  ...props
}: SelectProps) {
  const generatedId = useId()
  const triggerId = id ?? `select-${generatedId}`
  const menuId = `${triggerId}-menu`

  const normalizedOptions = normalizeOptions(options, children).map((option) => ({
    ...option,
    placeholder: option.placeholder ?? (option.value === '' && hasTextValue(placeholder)),
  }))

  const {
    isControlled,
    selectedValue,
    selectedOption,
    selectedText,
    showPlaceholder,
    setInternalValue,
  } = useSelectValue({ value, defaultValue, placeholder, normalizedOptions })

  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [query, setQuery] = useState('')

  // Search box is auto-enabled for long lists, or forced via the `searchable`
  // prop. `visibleOptions` is what the menu renders and what keyboard
  // navigation operates over — the hidden native <select> still carries the
  // full option set for form semantics.
  const searchEnabled = searchable ?? normalizedOptions.length > SEARCH_THRESHOLD
  const trimmedQuery = query.trim().toLowerCase()
  const visibleOptions =
    searchEnabled && trimmedQuery
      ? // While searching, show a flat list of matches — group headers are
        // dropped so a query never leaves a lone heading with no items.
        normalizedOptions.filter(
          (option) => !option.header && option.textValue.toLowerCase().includes(trimmedQuery),
        )
      : normalizedOptions

  const nativeSelectRef = useRef<HTMLSelectElement | null>(null)
  const selectRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLInputElement | null>(null)

  // The dropdown's dismiss anchor is ALWAYS the Select's own wrapper —
  // not a wider parent the caller may pass via `menuAnchorRef`. This is
  // critical for two UX behaviours:
  //
  //   1. Clicking another Select that lives inside the same wider parent
  //      (e.g. two ratio selects sharing one `baseSettings` row) closes
  //      the currently open menu, so opening the new one feels seamless.
  //   2. Clicking the trigger of an open menu toggles it closed (the
  //      `onClick` handler reads `open` and routes to closeMenu). If the
  //      wider parent gated dismiss, mousedown wouldn't fire onClose, but
  //      the click would still be eaten by the open menu's own logic.
  //
  // The wider `menuAnchorRef` only contributes to the menu's HORIZONTAL
  // extent (width + x for left edge) via `getAnchorRect()` and the
  // `menuSizing.width` prop — both used purely for layout.
  const resolvedAnchorRef = useRef<HTMLElement | null>(null)

  const { menuSizing, getAnchorRect, updateMenuSizing, clearMenuSizing } = useSelectMenuAnchor({
    open,
    menuPlacement,
    menuAnchorRef,
    menuMinWidth,
    selectRef,
  })

  const resolvedActiveIndex =
    open && isEnabledOptionIndex(visibleOptions, activeIndex)
      ? activeIndex
      : getInitialActiveIndex(visibleOptions, selectedValue)
  const activeOptionId =
    open && resolvedActiveIndex >= 0 ? getOptionId(menuId, resolvedActiveIndex) : undefined

  function setSelectRef(node: HTMLSelectElement | null) {
    nativeSelectRef.current = node
    assignRef(ref, node)
  }

  function closeMenu() {
    setOpen(false)
    setActiveIndex(-1)
    setQuery('')
    clearMenuSizing()
    resolvedAnchorRef.current = null
    // Tear down any transient hover preview when the menu goes away — by
    // commit, dismiss, or escape. commitValue calls closeMenu before firing
    // onChange, so the preview is cleared just before the real value lands.
    onOptionPreviewClear?.()
  }

  function openMenu() {
    if (disabled) return
    // The dismiss anchor is always the Select itself. See comment on
    // `resolvedAnchorRef` for why this matters.
    resolvedAnchorRef.current = selectRef.current
    updateMenuSizing()
    setActiveIndex(getInitialActiveIndex(normalizedOptions, selectedValue))
    setQuery('')
    setOpen(true)
  }

  function commitValue(nextValue: string) {
    if (disabled) return
    if (!isControlled) setInternalValue(nextValue)
    closeMenu()

    const select = nativeSelectRef.current
    if (select) select.value = nextValue
    onChange?.({
      target: select ?? ({ value: nextValue, name } as HTMLSelectElement),
      currentTarget: select ?? ({ value: nextValue, name } as HTMLSelectElement),
    } as ChangeEvent<HTMLSelectElement>)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function handleNativeChange(event: ChangeEvent<HTMLSelectElement>) {
    if (!isControlled) setInternalValue(event.target.value)
    onChange?.(event)
  }

  function handleTriggerChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value
    const matchingOption = normalizedOptions.find(
      (option) => option.value === next || option.textValue === next,
    )
    if (matchingOption && !matchingOption.disabled) {
      commitValue(matchingOption.value)
    }
  }

  function handleSelectClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target
    if (
      event.defaultPrevented ||
      disabled ||
      !(target instanceof Node) ||
      !selectRef.current?.contains(target)
    ) {
      return
    }
    triggerRef.current?.focus()
    // Toggle so a second click on the trigger closes an already-open menu.
    // The document-level mousedown listener inside ContextMenu does NOT fire
    // for this click (the trigger is `anchorRef.current`, so dismiss is
    // suppressed), which would otherwise leave the menu permanently open.
    if (open) {
      closeMenu()
    } else {
      openMenu()
    }
  }

  const keyboardContext = {
    open,
    options: visibleOptions,
    activeIndex: resolvedActiveIndex,
    setActiveIndex,
    openMenu,
    closeMenu,
    commitValue,
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    handleSelectKeyDown(event, keyboardContext)
  }

  // The in-menu search box owns focus while open, so it must drive list
  // navigation too. Only the navigation keys are intercepted — every other
  // key (letters, digits, Space, Backspace) types into the box. This is why
  // we can't route through `handleSelectKeyDown` wholesale: that handler
  // treats Space as "commit", which would stop the user typing spaces.
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (SEARCH_NAV_KEYS.has(event.key)) {
      handleSelectKeyDown(event, keyboardContext)
    }
  }

  function handleQueryChange(next: string) {
    setQuery(next)
    // Reset the highlight so it lands on the first match (or the selected
    // option if it survived the filter) instead of a now-stale index.
    setActiveIndex(-1)
  }

  return (
    <div
      ref={selectRef}
      className={cn(
        styles.select,
        styles[`size-${fieldSize}`],
        invalid && styles.invalid,
        disabled && styles.disabled,
        className,
      )}
      data-emphasis={emphasis !== 'default' ? emphasis : undefined}
      data-open={open ? 'true' : undefined}
      onClick={handleSelectClick}
    >
      <select
        ref={setSelectRef}
        id={`${triggerId}-native`}
        name={name}
        required={required}
        disabled={disabled}
        value={selectedValue}
        onChange={handleNativeChange}
        tabIndex={-1}
        aria-hidden="true"
        className={styles.nativeSelect}
        {...props}
      >
        {options ? (
          normalizedOptions.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.textValue}
            </option>
          ))
        ) : children}
      </select>

      {selectedOption?.icon && (
        <span aria-hidden="true" className={styles.leadingIcon}>
          <SelectIcon icon={selectedOption.icon} />
        </span>
      )}

      <input
        ref={triggerRef}
        id={triggerId}
        role="combobox"
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={activeOptionId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={invalid || props['aria-invalid'] ? true : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-testid={dataTestId}
        data-placeholder={showPlaceholder ? 'true' : undefined}
        disabled={disabled}
        readOnly
        value={selectedText}
        placeholder={placeholder}
        onChange={handleTriggerChange}
        onKeyDown={handleTriggerKeyDown}
        className={styles.trigger}
      />

      <span aria-hidden="true" className={styles.chevron}>
        <ChevronDown2Icon size={12} />
      </span>

      {open && menuSizing && (
        <SelectMenu
          menuId={menuId}
          anchorRef={resolvedAnchorRef}
          getAnchorRect={getAnchorRect}
          menuPlacement={menuPlacement}
          menuSizing={menuSizing}
          maxHeight={menuMaxHeight}
          ariaLabel={ariaLabel}
          ariaLabelledBy={ariaLabelledBy}
          options={visibleOptions}
          activeIndex={resolvedActiveIndex}
          activeOptionId={activeOptionId}
          selectedValue={selectedValue}
          searchable={searchEnabled}
          query={query}
          searchPlaceholder={searchPlaceholder}
          onQueryChange={handleQueryChange}
          onSearchKeyDown={handleSearchKeyDown}
          onHover={setActiveIndex}
          onOptionPreview={onOptionPreview}
          onSelect={commitValue}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(value)
  } else {
    ref.current = value
  }
}

function SelectIcon({ icon }: { icon: ReactNode }) {
  return icon
}
