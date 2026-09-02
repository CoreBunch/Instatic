import { createPortal } from 'react-dom'
import { useUiMessages } from '@ui/i18n'
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { ContextMenu, ContextMenuItem, MenuSearchHeader } from '@ui/components/ContextMenu'
import styles from './Select.module.css'
import { getOptionId, type NormalizedSelectOption } from './SelectOption'
import type { MenuPlacement, MenuSizing } from './useSelectMenuAnchor'

interface SelectMenuProps {
  menuId: string
  anchorRef: RefObject<HTMLElement | null>
  getAnchorRect: () => DOMRect | null
  menuPlacement: MenuPlacement
  menuSizing: MenuSizing
  maxHeight: number
  ariaLabel: string | undefined
  ariaLabelledBy: string | undefined
  options: NormalizedSelectOption[]
  activeIndex: number
  activeOptionId: string | undefined
  selectedValue: string
  /** Whether the in-menu search box is shown. */
  searchable: boolean
  query: string
  searchPlaceholder: string
  onQueryChange: (value: string) => void
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onHover: (index: number) => void
  /**
   * Optional hover-preview hook. Fired with an option's value when the
   * pointer enters its row, so callers can transiently apply the value
   * (e.g. preview a CSS value on the canvas) without committing it.
   */
  onOptionPreview?: (value: string) => void
  onSelect: (value: string) => void
  onClose: () => void
}

export function SelectMenu({
  menuId,
  anchorRef,
  getAnchorRect,
  menuPlacement,
  menuSizing,
  maxHeight,
  ariaLabel,
  ariaLabelledBy,
  options,
  activeIndex,
  activeOptionId,
  selectedValue,
  searchable,
  query,
  searchPlaceholder,
  onQueryChange,
  onSearchKeyDown,
  onHover,
  onOptionPreview,
  onSelect,
  onClose,
}: SelectMenuProps) {
  const t = useUiMessages()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const menuElRef = useRef<HTMLDivElement>(null)

  // Move focus into the search box once the menu mounts so the user can type
  // immediately. rAF defers past the menu's measuring frame (rendered
  // `visibility: hidden`) so focus lands on the visible field.
  useEffect(() => {
    if (!searchable) return
    const id = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [searchable])

  // Keep the keyboard-highlighted option inside the scroll viewport — with a
  // 300+ item list the active row otherwise drifts out of view as the user
  // arrows through it.
  useEffect(() => {
    if (activeOptionId == null) return
    // getElementById (not querySelector) so the `useId`-generated colons in
    // the option id don't need CSS escaping.
    const active = menuElRef.current?.ownerDocument.getElementById(activeOptionId)
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeOptionId])

  return createPortal(
    <ContextMenu
      ref={menuElRef}
      id={menuId}
      anchorRef={anchorRef}
      getAnchorRect={getAnchorRect}
      side={menuPlacement === 'left-start' ? 'left' : 'auto'}
      align="start"
      offset={6}
      width={menuSizing.width}
      minWidth={menuSizing.minWidth}
      maxHeight={maxHeight}
      zIndex={10000}
      ariaLabel={ariaLabel ?? t('selectOption')}
      aria-labelledby={ariaLabelledBy}
      role="listbox"
      onClose={onClose}
      header={searchable ? (
        <MenuSearchHeader
          inputRef={searchInputRef}
          value={query}
          onValueChange={onQueryChange}
          onKeyDown={onSearchKeyDown}
          placeholder={searchPlaceholder}
          controls={menuId}
          activeOptionId={activeOptionId}
        />
      ) : undefined}
    >
      {options.length === 0 ? (
        <div className={styles.emptyOption} role="presentation">
          {t('noMatches')}
        </div>
      ) : (
        options.map((option, index) =>
          option.header ? (
            <div
              key={option.value}
              className={styles.groupHeader}
              role="presentation"
            >
              {option.label}
            </div>
          ) : (
            <ContextMenuItem
              key={option.value}
              id={getOptionId(menuId, index)}
              active={index === activeIndex}
              role="option"
              aria-selected={option.value === selectedValue}
              disabled={option.disabled}
              data-placeholder-option={option.placeholder ? 'true' : undefined}
              className={option.placeholder ? styles.placeholderOption : undefined}
              tabIndex={-1}
              onMouseEnter={() => {
                if (option.disabled) return
                onHover(index)
                onOptionPreview?.(option.value)
              }}
              onClick={() => onSelect(option.value)}
            >
              {option.icon && (
                <span aria-hidden="true">
                  {option.icon}
                </span>
              )}
              <span className={styles.optionLabel}>{option.label}</span>
            </ContextMenuItem>
          ),
        )
      )}
    </ContextMenu>,
    document.body,
  )
}
