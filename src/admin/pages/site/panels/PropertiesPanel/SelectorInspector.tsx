/**
 * SelectorInspector — Properties panel body when a class is selected via the
 * global Selectors panel (no node context, just the rule + style sections).
 *
 * Renders the StyleCategoryRail for category nav and a StyleRuleComposer body
 * that lists / edits the rule's CSS properties. A search input above filters
 * by property name.
 *
 * Generated utility classes (those gated by `isGeneratedClassLocked`) render
 * a locked-state empty card instead of editable surfaces.
 */
import { useRef, useState } from 'react'
import { SearchBar } from '@ui/components/SearchBar'
import { isGeneratedClassLocked, styleRuleSelector } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import { StyleRuleComposer } from './StyleRuleComposer'
import { StyleCategoryRail } from './StyleCategoryRail'
import { GeneratedUtilityLockedState } from './StyleSurface'
import { useScrollSpy } from './useScrollSpy'
import {
  CLASS_STYLE_SECTIONS,
  getClassStyleSectionSetCounts,
} from './cssControlTypes'
import { getActiveStyleTab } from '@site/store/useActiveStyleTarget'
import styles from './PropertiesPanel.module.css'

const FIRST_STYLE_SECTION_ID = CLASS_STYLE_SECTIONS[0].id

interface SelectorInspectorProps {
  cls: StyleRule
  activeBreakpointId: string | undefined
}

export function SelectorInspector({ cls, activeBreakpointId }: SelectorInspectorProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [styleQuery, setStyleQuery] = useState('')
  const clearStyleQuery = () => setStyleQuery('')
  const selectorLabel = styleRuleSelector(cls)

  // Active section + click-to-scroll behaviour (shared with StyleSurface).
  const { activeId: activeAnchorId, scrollTo: handleSectionClick } = useScrollSpy(scrollRef, {
    initialId: FIRST_STYLE_SECTION_ID,
  })

  if (isGeneratedClassLocked(cls)) {
    return (
      <div className={styles.nodeArea}>
        <GeneratedUtilityLockedState cls={cls} />
      </div>
    )
  }

  const activeTab = getActiveStyleTab(activeBreakpointId)
  const storedStyles = activeTab !== 'base' ? (cls.contextStyles[activeTab] ?? {}) : cls.styles
  const sectionSetCounts = getClassStyleSectionSetCounts(storedStyles)

  return (
    <div className={styles.nodeArea}>
      <div className={styles.selectorSearchBar}>
        <SearchBar
          value={styleQuery}
          onValueChange={setStyleQuery}
          onClear={clearStyleQuery}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              clearStyleQuery()
            }
          }}
          placeholder={`Search styles in ${selectorLabel}...`}
          aria-label="Search class style properties to add"
        />
      </div>
      <div className={styles.selectorSurfaceLayout}>
        <div ref={scrollRef} className={styles.selectorScrollContainer}>
          <StyleRuleComposer
            key={cls.id}
            classId={cls.id}
            cls={cls}
            styleQuery={styleQuery}
            mode="global"
          />
        </div>
        <StyleCategoryRail
          activeAnchorId={activeAnchorId}
          sectionSetCounts={sectionSetCounts}
          onSectionClick={handleSectionClick}
          definition={null}
          activeClass={cls}
        />
      </div>
    </div>
  )
}
