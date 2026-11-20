/**
 * StyleRuleComposer — CSS section content renderer for a single style rule.
 *
 * Renders the style property sections for the given style rule (any selector,
 * not just a class) filtered by activeStyleSectionId and styleQuery. The rail,
 * search bar, and section navigation are owned by the parent (StyleSurface).
 */

import { useEditorStore } from '@site/store/store'
import type { StyleRule, CSSPropertyBag } from '@core/page-tree'
import { StyleSectionsEditor } from './StyleSectionsEditor'
import { getActiveStyleTab } from './cssControlTypes'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleRuleComposerProps {
  classId: string
  cls: StyleRule
  /** Search query — filters visible properties across all categories. */
  textElement?: boolean
  styleQuery: string
  mode?: 'contextual' | 'global'
}

// ---------------------------------------------------------------------------
// StyleRuleComposer
// ---------------------------------------------------------------------------

export function StyleRuleComposer({
  classId,
  cls,
  textElement,
  styleQuery,
  mode: _mode = 'contextual',
}: StyleRuleComposerProps) {
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  // The editing context is owned by the canvas toolbar's context switcher:
  // either the active viewport (base / breakpoint) or a custom condition. The
  // selector validates the active condition id against the registry and returns
  // a stable string | null, so a stale id (condition removed) falls back to
  // viewport editing without re-render churn.
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const cs = s.site?.conditions
    return cs && cs.some((c) => c.id === id) ? id : null
  })
  const updateClassStyles = useEditorStore((s) => s.updateClassStyles)
  const setClassContextStyles = useEditorStore((s) => s.setClassContextStyles)
  const removeClassStyleProperty = useEditorStore((s) => s.removeClassStyleProperty)
  const clearClassStyleProperties = useEditorStore((s) => s.clearClassStyleProperties)
  const setPreviewClassStyles = useEditorStore((s) => s.setPreviewClassStyles)
  const clearPreviewClassStyles = useEditorStore((s) => s.clearPreviewClassStyles)

  const onCondition = activeConditionId !== null

  const activeTab = getActiveStyleTab(activeBreakpointId)

  // The active context key: a condition id, a breakpoint id, or none (base).
  const activeContextId = onCondition
    ? activeConditionId
    : activeTab !== 'base'
      ? activeTab
      : null

  const storedStyles: Record<string, unknown> = activeContextId
    ? (cls.contextStyles[activeContextId] ?? {})
    : cls.styles
  const currentStyles: Record<string, unknown> = activeContextId
    ? { ...cls.styles, ...storedStyles }
    : cls.styles

  const handleChangeMany = (patch: Partial<CSSPropertyBag>) => {
    if (activeContextId) {
      setClassContextStyles(classId, activeContextId, patch)
    } else {
      updateClassStyles(classId, patch)
    }
  }

  const handleChange = (key: keyof CSSPropertyBag, value: string | number | undefined) => {
    handleChangeMany({ [key]: value ?? null } as Partial<CSSPropertyBag>)
  }

  const handleRemoveProperty = (key: keyof CSSPropertyBag) => {
    handleChange(key, undefined)
  }

  /**
   * Fully clear a property — used by visual switchers (LayoutSection) where
   * the X / clear affordance must really make a property go away regardless
   * of whether the value at the active tab is stored or inherited from base.
   * Routes through `removeClassStyleProperty` which removes the key from
   * base styles AND every context override in a single history entry.
   */
  const handleClearProperty = (key: keyof CSSPropertyBag) => {
    if (onCondition && activeConditionId) {
      // On a custom-condition tab, "clear" removes the prop from that
      // condition's override bag only. On a viewport-context tab it clears the
      // property everywhere (base + every context) so the inherited base value
      // can't bleed through and leave the switcher segment stuck pressed.
      setClassContextStyles(classId, activeConditionId, {
        [key]: undefined,
      } as Partial<CSSPropertyBag>)
      return
    }
    removeClassStyleProperty(classId, key)
  }

  // Clear a group of properties everywhere (base + every context) in one undo
  // step — used when clearing `display` must also prune its flex/grid deps.
  const handleClearProperties = (keys: ReadonlyArray<keyof CSSPropertyBag>) => {
    clearClassStyleProperties(classId, keys)
  }

  // Preview a transient style patch on the canvas while a property
  // control's hover-suggestion menu is open. The preview lives entirely
  // in store UI state — no class document mutation, no history entry.
  const handlePreview = (patch: Partial<CSSPropertyBag>) => {
    setPreviewClassStyles({
      classId,
      contextId: activeContextId,
      styles: patch,
    })
  }

  const handleClearPreview = () => {
    clearPreviewClassStyles(classId)
  }

  // Re-key the section controls on the active editing context (base /
  // breakpoint / condition) so they remount and re-read the right stored bag
  // when the toolbar context switcher changes the target.
  const sectionKey = activeContextId ?? 'base'

  return (
    <StyleSectionsEditor
      textElement={textElement}
      storedStyles={storedStyles}
      currentStyles={currentStyles}
      sectionKey={sectionKey}
      styleQuery={styleQuery}
      onChange={handleChange}
      onChangeMany={handleChangeMany}
      onRemove={handleRemoveProperty}
      onClearProperty={handleClearProperty}
      onClearProperties={handleClearProperties}
      onPreview={handlePreview}
      onClearPreview={handleClearPreview}
    />
  )
}
