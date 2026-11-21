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

import { lazy, Suspense, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { ClassPropertyRow } from './ClassPropertyRow'
import { Section } from '@ui/components/Section'
import { SpacingBoxControl } from './SpacingBoxControl/SpacingBoxControl'
import { CustomPropertiesSection } from './CustomPropertiesSection'
import { TypographyMetrics, TextAlignment } from './TypographyControls'
import { FillRow } from './FillRow'
import { RadiusRow } from './RadiusRow'
import { BorderPopoutRow } from './BorderControl/BorderPopoutRow'
import { hasCustomShadow, readEffects } from './effectsModel'
import { SectionPropertyMenu } from './SectionPropertyMenu'
import { SizeSection } from './SizeSection'
import { EXTRA_LAYOUT_PROPERTIES } from './LayoutSection/extraProperties'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { LabeledControl } from './LayoutSection/LabeledControl'
import { LayoutSection } from './LayoutSection'
import { PositionSection } from './PositionSection'
import {
  orderedStyleSections,
  cssPropertyLabel,
  getCSSPropertyDefaultValue,
  type ClassStyleSectionDefinition,
} from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import styles from './StyleRuleComposer.module.css'
import sectionStyles from '@ui/components/Section/Section.module.css'

const EffectsSection = lazy(() => import('./EffectsSection').then((module) => ({ default: module.EffectsSection })))

const SPACING_SECTION_ID = 'spacing'
const LAYOUT_SECTION_ID = 'layout'
const POSITION_SECTION_ID = 'position'
const BORDER_CONTROLS = new Set<keyof CSSPropertyBag>([
  'borderTopWidth', 'borderTopStyle', 'borderTopColor',
  'borderRightWidth', 'borderRightStyle', 'borderRightColor',
  'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
  'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
  'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'outline', 'outlineOffset',
])

const ROW_LABELS: Partial<Record<keyof CSSPropertyBag, string>> = {
  visibility: 'Visible', backgroundColor: 'Fill', backgroundImage: 'Image', borderRadius: 'Radius',
  fontFamily: 'Font', fontWeight: 'Weight', letterSpacing: 'Spacing',
}

const STANDING_ROWS: Record<string, ReadonlyArray<keyof CSSPropertyBag>> = {
  size: ['width', 'height'],
  styles: ['opacity', 'visibility', 'backgroundColor', 'backgroundImage', 'overflow', 'borderRadius'],
  typography: ['fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlign', 'color'],
  effects: [],
  transforms: [],
  interaction: [],
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleSectionsEditorProps {
  /** The bag whose set/unset state drives the rows (the active editing target). */
  storedStyles: Record<string, unknown>
  /** Base-merged bag used for placeholder / inherited values. */
  currentStyles: Record<string, unknown>
  /** Re-key controls on editing-context change (base / breakpoint / condition). */
  textElement?: boolean
  sectionKey: string
  /** Search query — filters visible properties across all categories. */
  styleQuery: string
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
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
  textElement = false,
  styleQuery,
  onChangeMany,
  onChange,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
}: StyleSectionsEditorProps) {
  const visibleStyleSections = getVisibleStyleSections(styleQuery, textElement)

  // Default open/closed state for every section, from the user preference.
  const sectionsExpanded = useEditorPreference('propertiesSectionsExpanded')

  return (
    <div className={styles.styleSections}>
      {visibleStyleSections.map((section) => (
        <div key={section.id} data-style-section={section.id}>
          <StyleSectionGroup
            key={sectionKey}
            onChangeMany={onChangeMany}
            searching={Boolean(styleQuery.trim())}
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
  searching: boolean
  section: ClassStyleSectionDefinition
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  activeTab: string
  /** Initial open/closed state, from the `propertiesSectionsExpanded` preference. */
  defaultOpen: boolean
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
  onClearProperties: (properties: ReadonlyArray<keyof CSSPropertyBag>) => void
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
}

function StyleSectionGroup({
  searching,
  section,
  currentStyles,
  storedStyles,
  activeTab,
  defaultOpen,
  onChangeMany,
  onChange,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
}: StyleSectionGroupProps) {
  const [pending, setPending] = useState<keyof CSSPropertyBag>()
  const standing = STANDING_ROWS[section.id]
  const extras = section.id === LAYOUT_SECTION_ID ? EXTRA_LAYOUT_PROPERTIES
    : standing ? section.properties.filter((prop) => !standing.includes(prop) && !BORDER_CONTROLS.has(prop)) : []
  const rows = standing ? [
    ...standing.filter((prop) => section.properties.includes(prop)),
    ...extras.filter((prop) => searching || prop === pending || hasStyleValue(currentStyles[prop])),
  ] : []
  const borderVisible = section.id === 'styles' && section.properties.some((prop) => BORDER_CONTROLS.has(prop))
  const setCount = section.properties.filter((prop) => hasStyleValue(storedStyles[prop])).length

  // Per-property adapter over the patch-shaped section preview channel.
  const previewProperty = (
    property: keyof CSSPropertyBag,
    value: string | number | undefined,
  ) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)

  return (
    <Section
      headerAction={extras.length > 0 ? (expand) => (
        <SectionPropertyMenu
          sectionTitle={section.title}
          properties={extras}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          onAdd={(prop, value) => {
            if (hasStyleValue(value)) onChange(prop, value)
            else setPending(prop)
            expand()
          }}
        />
      ) : undefined}
      title={section.title}
      icon={section.icon}
      defaultOpen={defaultOpen}
      empty={!searching && standing?.length === 0 && rows.length === 0}
      forceOpen={searching}
      flush
      indicator={setCount > 0}
      indicatorTestId={`class-style-section-dot-${section.id}`}
      meta={setCount > 0 ? `${setCount} set` : undefined}
    >
      <div className={sectionStyles.sectionBody}>
        {section.id === SPACING_SECTION_ID ? (
          <div className={styles.spacingGroup}>
            <span className={styles.spacingLabel}>Spacing</span>
            <SpacingBoxControl
              key={activeTab}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
            />
          </div>
        ) : section.id === LAYOUT_SECTION_ID ? (
          <LayoutSection
            searchProperties={searching ? section.properties : undefined}
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
        ) : section.id === 'size' && rows.some((prop) => prop === 'width' || prop === 'height') ? (
          <SizeSection
            currentStyles={currentStyles}
            storedStyles={storedStyles}
            onChange={onChange}
            onChangeMany={onChangeMany}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : null}
        {section.id === 'effects' && (
          <Suspense fallback={null}>
            <EffectsSection onPreview={previewProperty} onClearPreview={onClearPreview} storedStyles={currentStyles} activeTab={activeTab} visibleProperties={section.properties}
              onChange={onChange} />
          </Suspense>
        )}
        {rows.map((prop) => {
          if (prop === 'backgroundColor') return <FillRow key={prop} current={currentStyles} stored={storedStyles} onChangeMany={onChangeMany} />
          if (prop === 'borderRadius') return <RadiusRow stored={storedStyles} onPreview={onPreview} onClearPreview={onClearPreview} key={prop} current={currentStyles} onChangeMany={onChangeMany} />
          if (section.id === 'effects' && !searching && readEffects({ [prop]: currentStyles[prop] }).length > 0) {
            // Keep raw compound CSS editable alongside a visual effect when it carries other functions or tokens.
            if (prop === 'boxShadow' && !hasCustomShadow(currentStyles[prop])) return null
            if ((prop === 'filter' || prop === 'backdropFilter') && /^blur\([^()]*\)$/i.test(String(currentStyles[prop]))) return null
          }
          if (section.id === 'size' && (prop === 'width' || prop === 'height')) return null
          if (prop === 'fontSize' || prop === 'lineHeight') {
            if (prop === 'lineHeight' && rows.includes('fontSize')) return null
            return <TypographyMetrics key="metrics" stored={storedStyles} current={currentStyles}
              onChange={onChange} onPreview={previewProperty} onClearPreview={onClearPreview} />
          }
          if (prop === 'textAlign') {
            return <TextAlignment key={prop} stored={storedStyles.textAlign} current={currentStyles.textAlign}
              onChange={(value) => onChange(prop, value)} onClear={() => onRemove(prop)} />
          }
          if (prop === 'visibility') {
            const visibility = currentStyles.visibility
            return (
              <LabeledControl key={prop} label="Visible" isSet={hasStyleValue(storedStyles.visibility)}>
                <SegmentedControl
                  fullWidth aria-label="Visible"
                  value={String(visibility ?? 'visible')}
                  options={[{ value: 'visible', label: 'Yes' }, { value: 'hidden', label: 'No' },
                    ...(hasStyleValue(visibility) && visibility !== 'visible' && visibility !== 'hidden'
                      ? [{ value: String(visibility), label: String(visibility) }] : [])]}
                  onChange={(value) => onChange('visibility', value)}
                  onClear={() => onRemove('visibility')}
                />
              </LabeledControl>
            )
          }
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
              labelText={ROW_LABELS[prop]}
              value={isSet ? storedValue : undefined}
              placeholder={!isSet ? fallbackValue : undefined}
              fontFamilyValue={currentStyles.fontFamily}
              isSet={isSet}
              onChange={(property, value) => {
                onChange(property, value)
                if (pending === property) setPending(undefined)
              }}
              onRemove={onRemove}
              onPreview={previewProperty}
              onClearPreview={onClearPreview}
            />
          )
        })}
        {borderVisible && (
          <LabeledControl label="Border" isSet={section.properties.some((prop) => BORDER_CONTROLS.has(prop) && hasStyleValue(storedStyles[prop]))}>
            <BorderPopoutRow activeTab={activeTab} storedStyles={storedStyles} currentStyles={currentStyles}
              onChangeMany={onChangeMany} onChange={onChange}
              onPreview={onPreview} onClearPreview={onClearPreview} />
          </LabeledControl>
        )}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Section filtering by search query
// ---------------------------------------------------------------------------

function getVisibleStyleSections(query: string, textElement: boolean): ReadonlyArray<ClassStyleSectionDefinition> {
  const normalizedQuery = query.trim().toLowerCase()

  return orderedStyleSections(textElement).map((section) => ({
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
  const visibleLabel = ROW_LABELS[prop]?.toLowerCase()
  return raw.includes(query) || label.includes(query) || Boolean(visibleLabel?.includes(query))
}
