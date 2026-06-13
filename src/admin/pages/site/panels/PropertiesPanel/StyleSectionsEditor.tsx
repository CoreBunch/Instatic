/**
 * StyleSectionsEditor — the target-agnostic CSS section renderer.
 *
 * This is the shared rendering core behind both `StyleRuleComposer` (edits a
 * StyleRule's `styles` / `contextStyles`) and `InlineStyleComposer` (edits a
 * node's `inlineStyles`). It knows nothing about WHERE the styles live: it
 * takes the resolved style bags plus a set of handlers and renders the curated
 * style sections (spacing / layout / position / border / …) followed by the
 * custom-properties editor.
 *
 * Keeping this seam in one place means the two editing targets can never drift
 * in which controls they expose.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { ClassPropertyRow } from './ClassPropertyRow'
import { Section } from '@ui/components/Section'
import { SpacingBoxControl } from './SpacingBoxControl/SpacingBoxControl'
import { BorderControl } from './BorderControl/BorderControl'
import { CustomPropertiesSection } from './CustomPropertiesSection'
import { LayoutSection } from './LayoutSection'
import { PositionSection } from './PositionSection'
import {
  CLASS_STYLE_SECTIONS,
  cssPropertyLabel,
  getCSSPropertyDefaultValue,
  type ClassStyleSectionDefinition,
} from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import styles from './StyleRuleComposer.module.css'
import sectionStyles from '@ui/components/Section/Section.module.css'

const SPACING_SECTION_ID = 'spacing'
const LAYOUT_SECTION_ID = 'layout'
const POSITION_SECTION_ID = 'position'
const BORDER_SECTION_ID = 'border'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleSectionsEditorProps {
  /** The bag whose set/unset state drives the rows (the active editing target). */
  storedStyles: Record<string, unknown>
  /** Base-merged bag used for placeholder / inherited values. */
  currentStyles: Record<string, unknown>
  /** Re-key controls on editing-context change (base / breakpoint / condition). */
  sectionKey: string
  /** Search query — filters visible properties across all categories. */
  styleQuery: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
  /** Clear several properties in one undo step (e.g. display + its flex/grid deps). */
  onClearProperties: (properties: ReadonlyArray<keyof CSSPropertyBag>) => void
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
}

// ---------------------------------------------------------------------------
// StyleSectionsEditor
// ---------------------------------------------------------------------------

export function StyleSectionsEditor({
  storedStyles,
  currentStyles,
  sectionKey,
  styleQuery,
  onChange,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
}: StyleSectionsEditorProps) {
  const visibleStyleSections = getVisibleStyleSections(styleQuery)

  // Default open/closed state for every section, from the user preference.
  const sectionsExpanded = useEditorPreference('propertiesSectionsExpanded')

  return (
    <div className={styles.styleSections}>
      {visibleStyleSections.map((section) => (
        <div key={section.id} data-style-section={section.id}>
          <StyleSectionGroup
            section={section}
            currentStyles={currentStyles}
            storedStyles={storedStyles}
            activeTab={sectionKey}
            defaultOpen={sectionsExpanded}
            onChange={onChange}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onClearProperties={onClearProperties}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </div>
      ))}
      {/* Custom properties — generic editor for the long tail of CSS the curated
          sections don't claim. Hidden while a style search is active. */}
      {!styleQuery.trim() && (
        <div data-style-section="custom">
          <CustomPropertiesSection
            key={sectionKey}
            storedStyles={storedStyles}
            defaultOpen={sectionsExpanded}
            onChange={onChange}
            onRemove={onRemove}
          />
        </div>
      )}
      {visibleStyleSections.length === 0 && styleQuery.trim() && (
        <div className={styles.noStyleMatches}>No matching styles.</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// StyleSectionGroup — one curated section (spacing / layout / … / generic rows)
// ---------------------------------------------------------------------------

interface StyleSectionGroupProps {
  section: ClassStyleSectionDefinition
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  activeTab: string
  /** Initial open/closed state, from the `propertiesSectionsExpanded` preference. */
  defaultOpen: boolean
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
  onClearProperties: (properties: ReadonlyArray<keyof CSSPropertyBag>) => void
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
}

function StyleSectionGroup({
  section,
  currentStyles,
  storedStyles,
  activeTab,
  defaultOpen,
  onChange,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
}: StyleSectionGroupProps) {
  const setCount = section.properties.filter((prop) => hasStyleValue(storedStyles[prop])).length

  // Per-property adapter over the patch-shaped section preview channel.
  const previewProperty = (
    property: keyof CSSPropertyBag,
    value: string | number | undefined,
  ) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)

  return (
    <Section
      title={section.title}
      icon={section.icon}
      defaultOpen={defaultOpen}
      flush
      indicator={setCount > 0}
      indicatorTestId={`class-style-section-dot-${section.id}`}
      meta={setCount > 0 ? `${setCount} set` : undefined}
    >
      <div className={sectionStyles.sectionBody}>
        {section.id === SPACING_SECTION_ID ? (
          <SpacingBoxControl
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === LAYOUT_SECTION_ID ? (
          <LayoutSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onClearProperties={onClearProperties}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === POSITION_SECTION_ID ? (
          <PositionSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === BORDER_SECTION_ID ? (
          <>
            <BorderControl
              key={activeTab}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onClearProperty={onClearProperty}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
            />
            <AdvancedRows
              activeTab={activeTab}
              properties={BORDER_ADVANCED_PROPERTIES}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={previewProperty}
              onClearPreview={onClearPreview}
            />
          </>
        ) : (
          section.properties.map((prop) => {
            const storedValue = storedStyles[prop]
            const isSet = hasStyleValue(storedValue)
            const currentValue = currentStyles[prop]
            const fallbackValue = hasStyleValue(currentValue)
              ? currentValue
              : getCSSPropertyDefaultValue(prop)

            return (
              <ClassPropertyRow
                key={`${activeTab}-${String(prop)}`}
                property={prop}
                value={isSet ? (storedValue as string | number) : undefined}
                placeholder={!isSet ? fallbackValue : undefined}
                isSet={isSet}
                onChange={onChange}
                onRemove={onRemove}
                onPreview={previewProperty}
                onClearPreview={onClearPreview}
              />
            )
          })
        )}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Border advanced rows — raw CSS shorthand props the visual BorderControl
// deliberately doesn't surface, kept available behind a disclosure.
// ---------------------------------------------------------------------------

const BORDER_ADVANCED_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'appearance',
]

interface AdvancedRowsProps {
  activeTab: string
  properties: ReadonlyArray<keyof CSSPropertyBag>
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function AdvancedRows({
  activeTab,
  properties,
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: AdvancedRowsProps) {
  const anySet = properties.some((prop) => hasStyleValue(storedStyles[prop]))

  return (
    <details className={styles.advanced} open={anySet}>
      <summary className={styles.advancedSummary}>Advanced</summary>
      <div className={styles.advancedBody}>
        {properties.map((prop) => {
          const storedValue = storedStyles[prop]
          const isSet = hasStyleValue(storedValue)
          const currentValue = currentStyles[prop]
          const fallbackValue = hasStyleValue(currentValue)
            ? currentValue
            : getCSSPropertyDefaultValue(prop)
          return (
            <ClassPropertyRow
              key={`${activeTab}-${String(prop)}`}
              property={prop}
              value={isSet ? (storedValue as string | number) : undefined}
              placeholder={!isSet ? fallbackValue : undefined}
              isSet={isSet}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
            />
          )
        })}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Section filtering by search query
// ---------------------------------------------------------------------------

function getVisibleStyleSections(query: string): ReadonlyArray<ClassStyleSectionDefinition> {
  const normalizedQuery = query.trim().toLowerCase()

  return CLASS_STYLE_SECTIONS.map((section) => ({
    ...section,
    properties: section.properties.filter(
      (prop) =>
        !normalizedQuery ||
        sectionMatchesQuery(section, normalizedQuery) ||
        propertyMatchesQuery(prop, normalizedQuery),
    ),
  })).filter((section) => section.properties.length > 0)
}

function sectionMatchesQuery(section: ClassStyleSectionDefinition, query: string): boolean {
  return section.id.toLowerCase().includes(query) || section.title.toLowerCase().includes(query)
}

function propertyMatchesQuery(prop: keyof CSSPropertyBag, query: string): boolean {
  const raw = String(prop).toLowerCase()
  const label = cssPropertyLabel(String(prop)).toLowerCase()
  return raw.includes(query) || label.includes(query)
}
