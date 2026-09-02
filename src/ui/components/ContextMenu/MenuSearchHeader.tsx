import { type KeyboardEvent, type Ref } from 'react'
import { SearchBar } from '@ui/components/SearchBar'
import { useUiMessages } from '@ui/i18n'
import styles from './ContextMenu.module.css'

interface MenuSearchHeaderProps {
  value: string
  onValueChange: (value: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  placeholder?: string
  /** Forwarded to the search input — used to auto-focus on menu open. */
  inputRef?: Ref<HTMLInputElement>
  /** Id of the listbox/menu the search box controls, for combobox semantics. */
  controls?: string
  /** Id of the currently highlighted option, for combobox semantics. */
  activeOptionId?: string
}

/**
 * Sticky search field rendered at the top of a scrollable {@link ContextMenu}.
 * Shared by every searchable dropdown (Select, ModelPicker) so the filter UI
 * — sticky positioning, combobox semantics, focus handling — stays identical.
 *
 * The owner component holds the query state and does the filtering; this is
 * purely the presentational header.
 */
export function MenuSearchHeader({
  value,
  onValueChange,
  onKeyDown,
  placeholder,
  inputRef,
  controls,
  activeOptionId,
}: MenuSearchHeaderProps) {
  const t = useUiMessages()
  const searchLabel = placeholder ?? t('search')
  return (
    <div className={styles.searchHeader}>
      <SearchBar
        ref={inputRef}
        value={value}
        onValueChange={onValueChange}
        onKeyDown={onKeyDown}
        placeholder={searchLabel}
        aria-label={searchLabel}
        role="combobox"
        aria-controls={controls}
        aria-expanded
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
      />
    </div>
  )
}
