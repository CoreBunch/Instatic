/**
 * StyleCategoryRail — primary navigation icon rail for the unified PropertiesPanel.
 *
 * Renders:
 *   1. Module button (first, always enabled) — uses `definition.icon`. Hidden in global mode.
 *   2. One button per CSS style category from CLASS_STYLE_SECTIONS.
 *
 * CSS category buttons are disabled (with hint tooltip) when no class is active.
 *
 * Exported sentinels:
 *   MODULE_CATEGORY_ID — 'module' (module settings tab)
 */

import { Button } from '@ui/components/Button'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { StyleRule } from '@core/page-tree'
import { getOrderedStyleSections } from './cssControlTypes'
import styles from './StyleCategoryRail.module.css'

// ---------------------------------------------------------------------------
// Sentinel IDs
// ---------------------------------------------------------------------------

export const MODULE_CATEGORY_ID = 'module'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleCategoryRailProps {
  /** Section id corresponding to the currently visible scroll anchor. */
  activeAnchorId: string
  sectionSetCounts: ReadonlyMap<string, number>
  /** Called when a rail button is clicked; caller handles scroll navigation. */
  onSectionClick: (sectionId: string) => void
  /**
   * Module definition for the Module button. When null/undefined the module
   * button is hidden (global selector mode).
   */
  definition?: AnyModuleDefinition | null
  /**
   * Currently active class. When null AND not editing inline styles, the CSS
   * category buttons are disabled.
   */
  activeClass: StyleRule | null
  /**
   * True when the panel is editing the node's inline styles. Unlocks the CSS
   * category buttons just like an active class does — inline editing is a real
   * style-editing target, it just writes `node.inlineStyles` instead of a rule.
   */
  editingInline?: boolean
  /** Text element selected — the rail mirrors the editor's hoisted order. */
  typographyFirst?: boolean
}

// ---------------------------------------------------------------------------
// ModuleRailButton — file-private sub-component so we can resolve the icon
// component reference cleanly (React requires PascalCase component variables).
// ---------------------------------------------------------------------------

function ModuleRailButton({
  definition,
  isActive,
  onClick,
}: {
  definition: AnyModuleDefinition
  isActive: boolean
  onClick: () => void
}) {
  const ModuleIcon = definition.icon
  return (
    <Button
      variant="ghost"
      size="xs"
      iconOnly
      pressed={isActive}
      onClick={onClick}
      aria-label={`Module settings — ${definition.name}`}
      tooltip={`${definition.name} settings`}
      className={styles.categoryRailButton}
      data-testid="style-category-module"
      aria-pressed={isActive}
    >
      <ModuleIcon size={14} aria-hidden="true" />
    </Button>
  )
}

// ---------------------------------------------------------------------------
// StyleCategoryRail
// ---------------------------------------------------------------------------

export function StyleCategoryRail({
  activeAnchorId,
  sectionSetCounts,
  onSectionClick,
  definition,
  activeClass,
  editingInline = false,
  typographyFirst = false,
}: StyleCategoryRailProps) {
  const stylesLocked = activeClass === null && !editingInline
  const disabledTooltip = 'Add a class to unlock styles'

  return (
    <div
      className={styles.categoryRail}
      role="toolbar"
      aria-label="Style categories"
      data-testid="style-category-rail"
    >

      {/* ── Module button — first, always enabled ─────────────────────── */}
      {definition != null && (
        <ModuleRailButton
          definition={definition}
          isActive={activeAnchorId === MODULE_CATEGORY_ID}
          onClick={() => onSectionClick(MODULE_CATEGORY_ID)}
        />
      )}

      {/* ── CSS category buttons ──────────────────────────────────────── */}
      {getOrderedStyleSections(typographyFirst).map((section) => {
        const SectionIcon = section.icon
        const setCount = sectionSetCounts.get(section.id) ?? 0
        const hasSetStyles = setCount > 0
        return (
          <Button
            key={section.id}
            variant="ghost"
            size="xs"
            iconOnly
            pressed={activeAnchorId === section.id}
            onClick={() => onSectionClick(section.id)}
            disabled={stylesLocked}
            aria-label={`Show ${section.title} styles`}
            tooltip={stylesLocked ? disabledTooltip : section.title}
            className={styles.categoryRailButton}
            data-has-set-styles={hasSetStyles ? 'true' : undefined}
            data-testid={`style-category-${section.id}`}
            aria-pressed={activeAnchorId === section.id}
          >
            <span className={styles.categoryRailIconWrap}>
              <SectionIcon size={14} aria-hidden="true" />
              {hasSetStyles && (
                <span
                  className={styles.categoryRailSetDot}
                  data-testid={`class-style-category-dot-${section.id}`}
                  aria-hidden="true"
                />
              )}
            </span>
          </Button>
        )
      })}
    </div>
  )
}
