/**
 * SectionAddMenu — the "+" action in a style-section header (inspector
 * redesign's `sec-head .add` + propmenu).
 *
 * Opens a searchable menu of the section's ADDABLE properties: the long tail
 * that has no always-visible row. Picking one stores its schema default, so
 * its row appears set and ready to edit.
 *
 * A property already present in the section stays LISTED, dimmed and ticked
 * (docs/features/inspector-panel.md §7.1). Dropping it out of the list makes
 * the menu's contents change under the user between two openings; keeping it
 * answers "is it already there?" without closing the menu to look.
 */

import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { Input } from '@ui/components/Input'
import { CheckGlyph, SearchGlyph } from '@ui/icons/inspectorGlyphs'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import {
  cssPropertyLabel,
  getCSSPropertyDefaultValue,
  getEnumOptions,
  NUMBER_TYPED_PROPS,
} from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import styles from './SectionAddMenu.module.css'

/**
 * Starter values for properties whose schema default is intentionally BLANK
 * (shorthands "left empty for manual entry"). A blank write stores nothing —
 * the row would never appear — so adding one of these seeds a visible,
 * editable value instead (the border editor's own defaults: 1px solid #222).
 */
const BLANK_DEFAULT_STARTERS: Partial<Record<keyof CSSPropertyBag, string>> = {
  border: '1px solid #222222',
  borderTop: '1px solid #222222',
  borderRight: '1px solid #222222',
  borderBottom: '1px solid #222222',
  borderLeft: '1px solid #222222',
  borderWidth: '1px',
  borderStyle: 'solid',
}

interface SectionAddMenuProps {
  /** Section title — used for aria labels ("Add Layout property"). */
  sectionTitle: string
  /** The section's ADDABLE catalog — long-tail props without a standing row. */
  properties: ReadonlyArray<keyof CSSPropertyBag>
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

export function SectionAddMenu({
  sectionTitle,
  properties,
  storedStyles,
  onChange,
}: SectionAddMenuProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  const addProperty = (prop: keyof CSSPropertyBag) => {
    const fallback = getCSSPropertyDefaultValue(prop)
    // Store the schema default so the row flips to "set" and is editable.
    // Number-typed properties (opacity, zIndex) persist as numbers. Blank
    // defaults would store nothing (and the row would never appear), so they
    // get a visible starter value instead.
    let next: string | number = NUMBER_TYPED_PROPS.has(prop) ? Number(fallback) : String(fallback)
    if (typeof next === 'string' && next.trim() === '') {
      next = BLANK_DEFAULT_STARTERS[prop] ?? getEnumOptions(prop)?.[0] ?? '0'
    }
    onChange(prop, next)
    close()
  }

  const trimmed = query.trim().toLowerCase()
  const visible = properties
    .filter((prop) => {
      if (!trimmed) return true
      return (
        cssPropertyLabel(String(prop)).toLowerCase().includes(trimmed) ||
        String(prop).toLowerCase().includes(trimmed)
      )
    })
    // `used` = the property already has a row in the section: shown, dimmed,
    // ticked, and inert. Enter and clicks skip it.
    .map((prop) => ({ prop, used: hasStyleValue(storedStyles[prop]) }))
  const addable = visible.filter((entry) => !entry.used)

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="micro"
        iconOnly
        className={styles.addButton}
        aria-label={`Add ${sectionTitle} property`}
        aria-haspopup="menu"
        aria-expanded={open}
        tooltip={`Add ${sectionTitle} property`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <PlusIcon size={12} color="currentColor" />
      </Button>
      {open && (
        <ContextMenu
          ariaLabel={`${sectionTitle} properties`}
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="bottom"
          offset={6}
          width={216}
          /* The prototype's `.list` scrolls past 244px — Styles alone offers
             18 addable properties, which would otherwise run off-screen. */
          maxHeight={244}
          menuClassName={styles.menu}
          onClose={close}
          header={
            <div className={styles.searchRow}>
              <span className={styles.searchIcon} aria-hidden="true">
                <SearchGlyph />
              </span>
              <Input
                className={styles.searchInput}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // Type-then-Enter adds the top match without reaching for
                  // the mouse (prototype: first non-used item is clicked).
                  if (event.key !== 'Enter') return
                  const first = addable[0]
                  if (!first) return
                  event.preventDefault()
                  addProperty(first.prop)
                }}
                placeholder="Type to search…"
                spellCheck={false}
                aria-label={`Search ${sectionTitle} properties`}
                autoFocus
              />
            </div>
          }
        >
          {visible.map(({ prop, used }) => (
            <ContextMenuItem
              key={String(prop)}
              disabled={used}
              className={used ? styles.itemUsed : undefined}
              onClick={() => addProperty(prop)}
            >
              <span className={styles.itemRow}>
                <span className={styles.itemLabel}>{cssPropertyLabel(String(prop))}</span>
                {used && (
                  <span className={styles.itemTick}>
                    <CheckGlyph />
                  </span>
                )}
              </span>
            </ContextMenuItem>
          ))}
          {visible.length === 0 && (
            <div className={styles.empty}>
              {trimmed ? 'No matching property.' : 'Nothing left to add.'}
            </div>
          )}
        </ContextMenu>
      )}
    </>
  )
}
