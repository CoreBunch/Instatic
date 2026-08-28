/**
 * DropdownSwitcher — shared segmented + dropdown control used by the Layout
 * and Position sections.
 *
 * Mirrors the prototype's `.buttongroup[data-more]` — one track, two states:
 *
 *   1. unset / primary value — `[ A | B | ⌄ ]`, the matching segment pressed
 *      (none when unset). Hovering the pressed segment reveals a close-icon
 *      overlay; clicking it clears the property.
 *   2. other value — the segments give way to a full-width value button
 *      (`Block`) and the chevron stays put. Clicking either opens the menu.
 *
 * The chevron always opens a ContextMenu listing every value in `allOptions`,
 * plus a trailing "Clear" item whenever the property is set — that item is the
 * clear affordance in state 2, where no segment is pressed to click.
 *
 * Identification (test id, data attribute, aria labels) is driven by
 * `property`, so the same shell works for `display`, `position`, and any
 * future CSS property that fits this mold.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { cn } from '@ui/cn'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { CheckGlyph } from '@ui/icons/inspectorGlyphs'
import styles from './LayoutSection.module.css'

interface PrimarySegment {
  value: string
  label?: ReactNode
  icon?: ReactNode
  ariaLabel?: string
  tooltip?: ReactNode
}

interface DropdownSwitcherProps {
  /** Lowercase CSS property name. Drives aria labels and test id. */
  property: string
  /** Current CSS value (undefined renders the unset segmented control). */
  value: string | undefined
  /** Segments promoted to the primary segmented row. */
  primarySegments: ReadonlyArray<PrimarySegment>
  /** Full value list shown in the chevron dropdown. */
  allOptions: ReadonlyArray<string>
  onChange: (value: string) => void
  onClear: () => void
  /**
   * Optional hover-preview hooks. When provided (and the `hoverPreview`
   * editor preference is on), hovering a value in the dropdown transiently
   * applies it via `onPreview`; closing / leaving the menu fires
   * `onClearPreview`. Lets the Layout / Position switchers preview a display
   * or position value on the canvas before the user commits.
   */
  onPreview?: (value: string) => void
  onClearPreview?: () => void
}

export function DropdownSwitcher({
  property,
  value,
  primarySegments,
  allOptions,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: DropdownSwitcherProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Hover previews are gated by the shared "Preview suggestions on hover"
  // preference; when off we don't fire preview callbacks at all.
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')
  const previewActive = hoverPreviewEnabled && onPreview != null

  // Defensive: clear any live preview if the preference flips off mid-hover.
  useEffect(() => {
    if (!hoverPreviewEnabled) onClearPreview?.()
  }, [hoverPreviewEnabled, onClearPreview])

  const closeMenu = () => {
    onClearPreview?.()
    setMenuOpen(false)
  }

  const toggleMenu = () => {
    if (menuOpen) closeMenu()
    else setMenuOpen(true)
  }

  const capitalized = capitalize(property)
  const testId = `css-${property}-switcher`
  const dataValueAttr = `data-${property}-value`

  const isSet = value != null && value !== ''
  const isPrimary = isSet && primarySegments.some((seg) => seg.value === value)
  const isOtherValue = isSet && !isPrimary

  const menu = menuOpen ? (
    <ContextMenu
      anchorRef={triggerRef}
      triggerRef={triggerRef}
      align="end"
      side="bottom"
      offset={6}
      ariaLabel={`${capitalized} values`}
      onClose={closeMenu}
      onMouseLeave={previewActive ? onClearPreview : undefined}
    >
      {allOptions.map((opt) => (
        <ContextMenuItem
          key={opt}
          role="menuitemradio"
          aria-checked={value === opt}
          active={value === opt}
          onMouseEnter={previewActive ? () => onPreview?.(opt) : undefined}
          onClick={() => {
            onChange(opt)
            closeMenu()
          }}
        >
          {optionLabel(opt)}
          {/* The chosen value carries a tick, same as any other menu in the
              panel (docs/features/inspector-panel.md §7.4). In chip mode no
              segment is pressed, so this is the only mark of what is on. */}
          {value === opt && (
            <span className={styles.menuTick}>
              <CheckGlyph />
            </span>
          )}
        </ContextMenuItem>
      ))}
      {isSet && <ContextMenuSeparator />}
      {isSet && (
        <ContextMenuItem
          onClick={() => {
            onClear()
            closeMenu()
          }}
        >
          Clear {property}
        </ContextMenuItem>
      )}
    </ContextMenu>
  ) : null

  return (
    <div
      className={styles.displayRow}
      data-testid={testId}
      {...{ [dataValueAttr]: value ?? '' }}
    >
      <SegmentedControl
        look="tiles"
        fullWidth
        aria-label={capitalized}
        value={isPrimary ? value : undefined}
        onChange={onChange}
        onClear={onClear}
        // In the other-value state the segments step aside for the value
        // button rendered in the trailing slot — same track, same chevron.
        options={
          isOtherValue
            ? []
            : primarySegments.map((seg) => ({
                value: seg.value,
                label: seg.label,
                icon: seg.icon,
                ariaLabel: seg.ariaLabel,
                tooltip: seg.tooltip,
              }))
        }
        trailing={({ segmentClassName, trailingClassName }) => (
          <>
            {isOtherValue && (
              <Button
                variant="secondary"
                size="sm"
                align="start"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={`${capitalized}: ${value}`}
                tooltip={`Change ${property} value`}
                className={cn(segmentClassName, styles.displayChip)}
                onClick={toggleMenu}
              >
                {optionLabel(value)}
              </Button>
            )}
            <Button
              ref={triggerRef}
              variant="secondary"
              size="sm"
              iconOnly
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`More ${property} values`}
              tooltip={`More ${property} values`}
              className={trailingClassName}
              onClick={toggleMenu}
            >
              <ChevronDownIcon size={14} color="currentColor" />
            </Button>
          </>
        )}
      />
      {menu}
    </div>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** `inline-block` → `Inline Block`, matching the prototype's menu labels. */
function optionLabel(value: string): string {
  return value.split('-').map(capitalize).join(' ')
}
