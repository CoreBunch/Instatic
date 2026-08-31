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
import { ControlRow } from '@ui/components/ControlRow'
import { SpacingBoxControl } from './SpacingBoxControl/SpacingBoxControl'
import { CustomPropertiesSection } from './CustomPropertiesSection'
import { LayoutSection } from './LayoutSection'
import { PositionSection } from './PositionSection'
import { SectionAddMenu } from './SectionAddMenu'
import { EffectsSection } from './EffectsSection'
import { EffectAddMenu } from './EffectAddMenu'
import { SizeSection } from './SizeSection'
import { StylesSection } from './StylesSection'
import { TypographySection } from './TypographySection'
import {
  getOrderedStyleSections,
  SECTION_ADDABLE_PROPERTIES,
  cssPropertyLabel,
  type ClassStyleSectionDefinition,
} from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import styles from './StyleRuleComposer.module.css'
import sectionStyles from '@ui/components/Section/Section.module.css'

const SPACING_SECTION_ID = 'spacing'
const LAYOUT_SECTION_ID = 'layout'
const POSITION_SECTION_ID = 'position'
const STYLES_SECTION_ID = 'styles'
const TYPOGRAPHY_SECTION_ID = 'typography'
const EFFECTS_SECTION_ID = 'effects'
const SIZE_SECTION_ID = 'size'

/**
 * Sections with NO curated standing rows — their whole body arrives through
 * the header's "+". While empty they refuse to open (there is nothing to
 * show); the first added row opens them.
 */
const ADD_ONLY_SECTION_IDS = new Set([EFFECTS_SECTION_ID, 'transforms', 'interaction'])

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
  /** Text element selected — Typography hoists to the front of the order. */
  typographyFirst?: boolean
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** Applies several properties in one store commit (one undo entry). */
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
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
  typographyFirst = false,
  onChange,
  onChangeMany,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
}: StyleSectionsEditorProps) {
  const visibleStyleSections = getVisibleStyleSections(styleQuery, typographyFirst)

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
            onChangeMany={onChangeMany}
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
  /** Applies several properties in one store commit (one undo entry). */
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
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
  onChangeMany,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
}: StyleSectionGroupProps) {

  // The add-menu lists only what can still be ADDED: the section's long tail
  // (no standing curated row), from the full catalog — never the search-
  // narrowed list, and never properties that already hold a value.
  const addableProperties = SECTION_ADDABLE_PROPERTIES.get(section.id)

  // Add-only sections lock closed while empty; the keyed remount below
  // re-initialises the open state, so the first added row opens the section
  // and clearing the last one collapses it again.
  const isAddOnly = ADD_ONLY_SECTION_IDS.has(section.id)
  const isEmpty = isAddOnly && !section.properties.some((prop) => hasStyleValue(storedStyles[prop]))

  // Per-property adapter over the patch-shaped section preview channel.
  const previewProperty = (
    property: keyof CSSPropertyBag,
    value: string | number | undefined,
  ) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)

  return (
    <Section
      key={isAddOnly ? `add-only-${isEmpty}` : undefined}
      title={section.title}
      defaultOpen={isAddOnly ? !isEmpty : defaultOpen}
      collapsible={!isEmpty}
      flush
      /* `.sec-head` is caret · name · "+" and nothing else
         (docs/features/inspector-panel.md §3). The set-signal lives where it
         is actionable: a dot on each set row, and one on the rail category. */
      headerAction={
        /* Effects adds an EFFECT, not a CSS property — its "+" opens its own
           catalogue (docs/features/inspector-panel.md §7.6). */
        section.id === EFFECTS_SECTION_ID ? (
          <EffectAddMenu storedStyles={storedStyles} onChange={onChange} />
        ) : addableProperties ? (
          <SectionAddMenu
            sectionTitle={section.title}
            properties={addableProperties}
            storedStyles={storedStyles}
            onChange={onChange}
          />
        ) : null
      }
    >
      <div className={sectionStyles.sectionBody}>
        {section.id === SPACING_SECTION_ID ? (
          /* The mock's Spacing row: label beside the box while it fits,
             box wrapping under it in a narrow dock. */
          <ControlRow
            label="Spacing"
            wide
            isSet={section.properties.some((prop) => hasStyleValue(storedStyles[prop]))}
          >
            <SpacingBoxControl
              key={activeTab}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
            />
          </ControlRow>
        ) : section.id === LAYOUT_SECTION_ID ? (
          <LayoutSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onChangeMany={onChangeMany}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onClearProperties={onClearProperties}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === SIZE_SECTION_ID ? (
          <SizeSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onChangeMany={onChangeMany}
            onRemove={onRemove}
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
        ) : section.id === STYLES_SECTION_ID ? (
          <StylesSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            visibleProperties={section.properties}
            onChange={onChange}
            onChangeMany={onChangeMany}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === EFFECTS_SECTION_ID ? (
          <EffectsSection
            key={activeTab}
            storedStyles={storedStyles}
            activeTab={activeTab}
            visibleProperties={section.properties}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === TYPOGRAPHY_SECTION_ID ? (
          <TypographySection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            visibleProperties={section.properties}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : (
          /* Generic sections (Transforms, Interaction): EMPTY until the user
             adds a property from the header's "+" — a row exists only while
             its property holds a value, and carries the remove handle. */
          section.properties
            .filter((prop) => hasStyleValue(storedStyles[prop]))
            .map((prop) => (
              <ClassPropertyRow
                key={`${activeTab}-${String(prop)}`}
                property={prop}
                value={storedStyles[prop] as string | number}
                fontFamilyValue={currentStyles.fontFamily}
                backgroundImageValue={currentStyles.backgroundImage}
                isSet
                removable
                onChange={onChange}
                onChangeMany={onChangeMany}
                onRemove={onRemove}
                onPreview={previewProperty}
                onClearPreview={onClearPreview}
              />
            ))
        )}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Section filtering by search query
// ---------------------------------------------------------------------------

function getVisibleStyleSections(
  query: string,
  typographyFirst: boolean,
): ReadonlyArray<ClassStyleSectionDefinition> {
  const normalizedQuery = query.trim().toLowerCase()

  return getOrderedStyleSections(typographyFirst).map((section) => ({
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
