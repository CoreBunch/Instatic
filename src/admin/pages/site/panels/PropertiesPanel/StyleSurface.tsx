/**
 * StyleSurface — unified properties editor surface.
 *
 * Layout: one continuous scrollable column with a sticky icon-rail on the
 * right and a sticky search bar pinned to the top.
 *
 * All sections render together in one scroll:
 *   1. Module settings — wrapped in a Section accordion, always first.
 *   2. CSS area — StyleRuleComposer (all CSS sections) or locked preview.
 *
 * The search bar is bound to the active editable class and filters across
 * module settings (by prop key/label) and the class's CSS properties
 * simultaneously. It is hidden when there is no active class (locked
 * preview) or when the active class is a locked generated utility — neither
 * state has editable CSS rows to search.
 *
 * Rail icons are scroll-anchor shortcuts; the active icon is derived from
 * scroll position.
 *
 * Global selector mode (definition === null):
 *   Module section and Module rail button are hidden.
 */

import { useState, useRef, type ReactNode } from 'react'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { StyleRule, CSSPropertyBag } from '@core/page-tree'
import { isGeneratedClassLocked, pickValidCSSProperties, styleRuleSelector } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { Section } from '@ui/components/Section'
import { StyleRuleComposer } from './StyleRuleComposer'
import { InlineStyleComposer } from './InlineStyleComposer'
import { ClassPropertyRow } from './ClassPropertyRow'
import { StyleCategoryRail, MODULE_CATEGORY_ID } from './StyleCategoryRail'
import { useScrollSpy } from './useScrollSpy'
import {
  CLASS_STYLE_SECTIONS,
  getCSSPropertyDefaultValue,
  getClassStyleSectionSetCounts,
} from './cssControlTypes'
import { getActiveStyleTab } from '@site/store/useActiveStyleTarget'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { EmptyState } from '@ui/components/EmptyState'
import styles from './StyleSurface.module.css'
import sectionStyles from '@ui/components/Section/Section.module.css'

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { GeneratedUtilityLockedState }

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleSurfaceProps {
  definition?: AnyModuleDefinition | null
  activeClass: StyleRule | null
  activeClassId: string | null
  activeBreakpointId: string | undefined
  /** Node id — triggers scroll reset when it changes. */
  nodeId: string | null
  /**
   * The selected node's inline styles (`node.inlineStyles`). When present (or
   * after the user clicks "Style inline"), the CSS area edits these directly —
   * the per-node `style=""` layer — instead of a class.
   */
  inlineStyles?: Record<string, unknown>
  /** Pre-rendered module prop rows shown in the Module section. */
  moduleContent?: ReactNode
  /** Called when 'Add class' is clicked in the locked preview. */
  onFocusClassPicker?: () => void
}

// ---------------------------------------------------------------------------
// StyleSurface
// ---------------------------------------------------------------------------

export function StyleSurface({
  definition,
  activeClass,
  activeClassId,
  activeBreakpointId,
  nodeId,
  inlineStyles,
  moduleContent,
  onFocusClassPicker,
}: StyleSurfaceProps) {
  // Text modules (the ones declaring `inlineTextEdit`) hoist Typography to
  // right after Position in the section order (author decision 2026-08-30).
  const typographyHoisted = definition?.inlineTextEdit != null
  // scrollRef → outer grid which is also the scroll container
  const scrollRef = useRef<HTMLDivElement>(null)
  const [styleQuery, setStyleQuery] = useState('')

  // Active section + click-to-scroll behaviour (shared with SelectorInspector).
  // The Module anchor is both the initial active section and the "scroll to
  // absolute top" target (so the sticky search bar above it is revealed); the
  // active anchor resets to it whenever the selected node changes.
  const { activeId: activeAnchorId, scrollTo: handleSectionClick } = useScrollSpy(scrollRef, {
    initialId: MODULE_CATEGORY_ID,
    scrollTopId: MODULE_CATEGORY_ID,
    resetKey: nodeId,
  })

  // Reset search query when active class changes (no state leak between pills).
  const [lastActiveClassId, setLastActiveClassId] = useState<string | null>(null)
  if (lastActiveClassId !== activeClassId) {
    setLastActiveClassId(activeClassId)
    if (styleQuery !== '') setStyleQuery('')
  }

  // Inline-vs-class edit target lives in the store (mutually exclusive with the
  // active class; reset on selection change in selectionSlice).
  const inlineStyleEditing = useEditorStore((s) => s.inlineStyleEditing)
  const setInlineStyleEditing = useEditorStore((s) => s.setInlineStyleEditing)

  // Default open/closed state for every property section (Module + CSS), driven
  // by the `propertiesSectionsExpanded` preference. Read once here; the CSS
  // sections receive it through StyleRuleComposer → StyleSectionsEditor.
  const sectionsExpanded = useEditorPreference('propertiesSectionsExpanded')

  const clearStyleQuery = () => setStyleQuery('')

  // Rail dot badges from stored styles at the active editing context. The
  // context switcher (canvas toolbar) can target a custom condition, which
  // wins over the viewport breakpoint; otherwise we fall back to the
  // base/breakpoint resolved by the active viewport.
  const activeTab = getActiveStyleTab(activeBreakpointId)
  // Validated active condition id (or null) — stale ids fall back to viewport.
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const cs = s.site?.conditions
    return cs && cs.some((c) => c.id === id) ? id : null
  })
  const activeContextId = activeConditionId ?? (activeTab !== 'base' ? activeTab : null)

  // Inline-style editing target: a node with no active class that either
  // already has inline styles or opted in via "Style inline". Inline styles are
  // base-only, so the breakpoint/condition context is irrelevant here.
  const permissions = useEditorPermissions()
  const canEditStyleHere = permissions.canEditStyle
  // `inlineStyleEditing` is the single source of truth for the edit target
  // (seeded on selection for inline-only nodes, toggled via the Inline pill /
  // "Style inline" button). It's mutually exclusive with an active class.
  const showInline = canEditStyleHere && nodeId != null && activeClass == null && inlineStyleEditing

  const storedStyles: Record<string, unknown> = showInline
    ? (inlineStyles ?? {})
    : activeClass
      ? (activeContextId ? (activeClass.contextStyles[activeContextId] ?? {}) : activeClass.styles)
      : {}
  const sectionSetCounts = getClassStyleSectionSetCounts(storedStyles)

  // Module section visibility: always visible unless search has no match.
  const hasModuleContent = definition != null && moduleContent != null
  const moduleVisible = hasModuleContent && (!styleQuery || moduleMatchesQuery(styleQuery, definition!))

  // The search bar is bound to the active class — both its placeholder and
  // the rows it filters belong to that class. It only renders when the class
  // exists and is editable.
  //   - no active class selected → LockedStylePreview teaser is shown instead
  //   - active class is a locked generated utility → GeneratedUtilityLockedState
  //     is shown instead (no editable CSS rows to search)
  const searchableClass = activeClass != null && !isGeneratedClassLocked(activeClass)
    ? activeClass
    : null

  // CSS area content. Branches in priority order:
  //  - caller lacks `site.style.edit`           → role-locked notice
  //  - inline-style editing target              → InlineStyleComposer
  //  - active class is set and editable         → StyleRuleComposer
  //  - active class is a locked generated utility → utility notice
  //  - no active class                          → teaser + "Add class"/"Style inline"
  let cssContent: ReactNode
  if (!canEditStyleHere) {
    cssContent = (
      <div className={styles.lockedContent}>
        <EmptyState
          variant="centered"
          title="Styles are read-only for your role"
          description="Your role can edit page copy but not classes or style overrides. Ask an editor to make visual changes."
        />
      </div>
    )
  } else if (showInline && activeContextId !== null) {
    // Inline styles are BASE-ONLY — a `style=""` attribute cannot change per
    // breakpoint/condition, so editing here would silently rewrite every
    // width. Block with a way out (author decision 2026-08-31).
    cssContent = (
      <InlineBreakpointBlockedState nodeId={nodeId!} />
    )
  } else if (showInline) {
    cssContent = (
      <InlineStyleComposer
        key={`${nodeId}-inline`}
        nodeId={nodeId!}
        inlineStyles={inlineStyles}
        styleQuery={styleQuery}
        typographyFirst={typographyHoisted}
      />
    )
  } else if (activeClass != null) {
    if (isGeneratedClassLocked(activeClass)) {
      cssContent = (
        <div className={styles.lockedContent}>
          <GeneratedUtilityLockedState cls={activeClass} />
        </div>
      )
    } else {
      cssContent = (
        <StyleRuleComposer
          key={`${activeClassId}-${activeTab}`}
          classId={activeClassId!}
          cls={activeClass}
          styleQuery={styleQuery}
          typographyFirst={typographyHoisted}
        />
      )
    }
  } else {
    cssContent = (
      <LockedStylePreview
        onFocusClassPicker={onFocusClassPicker ?? noop}
        onStyleInline={nodeId != null ? () => setInlineStyleEditing(true) : undefined}
      />
    )
  }

  // definition.icon is an IconComponent — must assign to PascalCase var.
  const ModuleIcon = definition?.icon

  return (
    <div ref={scrollRef} className={styles.surface}>
      {/* ── Left column: search + module section + CSS area ─────────── */}
      <div className={styles.surfaceContent}>

        {/* Search bar — sticky at the top, searches both module and CSS.
            Hidden when no class is selected or the active class is a locked
            generated utility (no CSS rows to search in either state). */}
        {searchableClass && (
          <div className={styles.searchBarRow}>
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
              placeholder={`Search styles in ${styleRuleSelector(searchableClass)}...`}
              aria-label="Search class style properties to add"
            />
          </div>
        )}

        {/* Module section — same Section accordion as CSS sections */}
        {moduleVisible && (
          <div data-style-section={MODULE_CATEGORY_ID}>
            <Section
              title={definition!.name}
              icon={ModuleIcon}
              defaultOpen={sectionsExpanded}
              flush
            >
              {/* sectionBody gives the same display:grid + gap as CSS sections.
                  key={nodeId} remounts on node change (replaces the old div wrapper). */}
              <div key={nodeId} className={sectionStyles.sectionBody}>
                {moduleContent}
              </div>
            </Section>
          </div>
        )}

        {/* CSS area — StyleRuleComposer sections, locked preview, or generated lock */}
        {cssContent}
      </div>

      {/* ── Right column: sticky rail ────────────────────────────── */}
      <div className={styles.railSticky}>
        <StyleCategoryRail
          activeAnchorId={activeAnchorId}
          sectionSetCounts={sectionSetCounts}
          onSectionClick={handleSectionClick}
          definition={definition ?? null}
          activeClass={activeClass}
          editingInline={showInline}
          typographyFirst={typographyHoisted}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// InlineBreakpointBlockedState — inline editing on a non-base context
// ---------------------------------------------------------------------------

/**
 * Shown instead of the inline composer when the editing context is a
 * breakpoint or condition: inline styles have no responsive axis, so the only
 * honest moves are (a) promote the inline bag into a class — which CAN hold
 * per-context overrides — or (b) go back to the base (Desktop) context.
 */
function InlineBreakpointBlockedState({ nodeId }: { nodeId: string }) {
  const node = useEditorStore((s) => selectActiveCanvasPage(s)?.nodes[nodeId] ?? null)
  const styleRules = useEditorStore((s) => s.site?.styleRules ?? null)
  const contextLabel = useEditorStore((s) => {
    const condition = s.site?.conditions?.find((c) => c.id === s.activeConditionId)
    if (condition) return condition.label
    return s.site?.breakpoints.find((bp) => bp.id === s.activeBreakpointId)?.label ?? 'this breakpoint'
  })
  const createClass = useEditorStore((s) => s.createClass)
  const addNodeClass = useEditorStore((s) => s.addNodeClass)
  const clearNodeInlineStyles = useEditorStore((s) => s.clearNodeInlineStyles)
  const setActiveClass = useEditorStore((s) => s.setActiveClass)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)

  const handleMoveToClass = () => {
    try {
      // Unnamed nodes fall back to their module's tail ("base.container" →
      // "container") so the created class reads like the element it styles.
      const base = (node?.label ?? node?.moduleId.split('.').pop() ?? 'element')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '') || 'element'
      const taken = new Set(Object.values(styleRules ?? {}).map((rule) => rule.name))
      let name = base
      for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
      const cls = createClass(name, pickValidCSSProperties(node?.inlineStyles ?? {}))
      addNodeClass(nodeId, cls.id)
      clearNodeInlineStyles(nodeId)
      // Activating the class also exits inline editing (mutually exclusive).
      setActiveClass(cls.id)
    } catch (err) {
      console.error('[StyleSurface] move inline styles to class:', err)
      pushToast({
        kind: 'error',
        title: 'Unable to move styles to a class',
        body: getErrorMessage(err, 'Unknown class error'),
      })
    }
  }

  return (
    <div className={styles.lockedContent}>
      <EmptyState
        variant="centered"
        title="Inline styles apply at every breakpoint"
        description={`This element is styled inline — a style attribute can't change per breakpoint. Move its styles to a class to override them on ${contextLabel}.`}
        action={
          <>
            <Button variant="secondary" size="sm" onClick={handleMoveToClass}>
              Move to a class
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setActiveBreakpoint('desktop')}>
              Edit base styles
            </Button>
          </>
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// LockedStylePreview — teaser shown when no class is set on the element
// ---------------------------------------------------------------------------

interface LockedStylePreviewProps {
  onFocusClassPicker: () => void
  /** When provided, shows a "Style inline" button that edits the node's
   *  `style=""` layer directly (no class). Omitted in selector/global mode. */
  onStyleInline?: () => void
}

const TEASER_SECTION = CLASS_STYLE_SECTIONS.find((s) => s.id === 'layout')!

function LockedStylePreview({ onFocusClassPicker, onStyleInline }: LockedStylePreviewProps) {
  const noopChange = () => {}
  const noopRemove = () => {}

  return (
    <div className={styles.lockedPreview}>
      {/* Teaser wrapper: capped height with gradient fade */}
      <div className={styles.lockedPreviewTeaserWrapper} aria-hidden="true">
        <div className={styles.lockedPreviewTeaser}>
          {TEASER_SECTION.properties.map((prop) => (
            <ClassPropertyRow
              key={String(prop)}
              property={prop}
              value={undefined}
              placeholder={getCSSPropertyDefaultValue(prop)}
              isSet={false}
              onChange={noopChange as (p: keyof CSSPropertyBag, v: string | number | undefined) => void}
              onRemove={noopRemove as (p: keyof CSSPropertyBag) => void}
            />
          ))}
        </div>
        <div className={styles.lockedPreviewGradient} aria-hidden="true" />
      </div>

      {/* CTA — always visible below the teaser */}
      <div className={styles.lockedPreviewCta}>
        <p className={styles.lockedPreviewCtaText}>
          Add a class to start styling this element
        </p>
        <div className={styles.lockedPreviewCtaActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={onFocusClassPicker}
          >
            Add class
          </Button>
          {onStyleInline && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onStyleInline}
              tooltip="Style just this element with an inline style attribute (no reusable class)"
            >
              Style inline
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GeneratedUtilityLockedState
// ---------------------------------------------------------------------------

function GeneratedUtilityLockedState({ cls }: { cls: StyleRule }) {
  const colorGenerated = cls.generated?.family === 'color' ? cls.generated : undefined
  const utility = colorGenerated?.utility
  const tokenName = cls.generated?.tokenName

  return (
    <div className={styles.generatedUtilityState}>
      <div className={styles.generatedUtilityHeader}>
        <span className={styles.generatedUtilityKicker}>Generated utility</span>
        <span className={styles.generatedUtilityName}>.{cls.name}</span>
      </div>
      <p className={styles.generatedUtilityCopy}>
        This is a utility class. Utility classes have a single purpose and aren&apos;t meant to be
        edited.
      </p>
      {(utility || tokenName) && (
        <div className={styles.generatedUtilityMeta}>
          {utility && <span>{utility}</span>}
          {tokenName && <span>{tokenName}</span>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the search query matches the module definition name or any
 * of its schema prop keys / labels. Used to show/hide the module section.
 */
function moduleMatchesQuery(query: string, definition: AnyModuleDefinition): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (definition.name.toLowerCase().includes(q)) return true
  return Object.keys(definition.schema).some((key) => {
    const label = key.replace(/([A-Z])/g, ' $1').trim().toLowerCase()
    return key.toLowerCase().includes(q) || label.includes(q)
  })
}

function noop() {}
