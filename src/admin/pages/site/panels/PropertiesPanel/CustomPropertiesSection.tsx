/**
 * CustomPropertiesSection — generic key/value editor for the long tail of CSS
 * the curated sections don't claim (CSS fidelity plan, Phase 1b).
 *
 * The permissive property model (Phase 1a) stores and publishes any valid CSS
 * property, but the visual panel only has bespoke widgets for a curated set.
 * Imported exotica (`grid-auto-flow`, `font-feature-settings`, …) and any
 * `--custom-property` land here as editable `name: value` rows, plus an
 * "Add property" affordance — the Webflow/Framer escape hatch.
 *
 * Rows render only for *set* uncurated properties (see `getCustomProperties`),
 * so a property never appears in both a curated section and here.
 *
 * Storage keys are stored verbatim (the camelCase the importer / store uses,
 * or `--custom` untouched). The display name kebab-cases camelCase keys back
 * to CSS form so `gridAutoFlow` reads as `grid-auto-flow`; custom properties
 * (`--brand`) display as-is.
 */
import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Section } from '@ui/components/Section'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { RemoveXGlyph } from '@ui/icons/inspectorGlyphs'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { getCustomProperties, isCuratedProperty } from './cssControlTypes'
import sectionStyles from '@ui/components/Section/Section.module.css'
import styles from './CustomPropertiesSection.module.css'

interface CustomPropertiesSectionProps {
  /** Active-tab stored styles (no inherited base merge). */
  storedStyles: Record<string, unknown>
  /** Initial open/closed state, from the `propertiesSectionsExpanded` preference. */
  defaultOpen: boolean
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
}

/**
 * Display a storage key as a CSS property name. Custom properties (`--brand`)
 * pass through; camelCase keys kebab-case back (`gridAutoFlow` →
 * `grid-auto-flow`).
 */
function displayName(key: string): string {
  if (key.startsWith('--')) return key
  return key.replace(/([A-Z])/g, '-$1').toLowerCase()
}

/**
 * Normalise a user-typed property name to a storage key. CSS property names
 * are case-insensitive (except custom props), so we lowercase and convert
 * kebab → camel for the standard props (matching how the importer / store
 * key everything). `--custom` is preserved verbatim.
 */
function toStorageKey(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('--')) return trimmed
  return trimmed.toLowerCase().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

const PROPERTY_NAME_RE = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/

export function CustomPropertiesSection({
  storedStyles,
  defaultOpen,
  onChange,
  onRemove,
}: CustomPropertiesSectionProps) {
  const customKeys = getCustomProperties(storedStyles)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  function commitNew() {
    const name = newName.trim()
    const value = newValue.trim()
    if (!name || !value) {
      setError('Both a property name and a value are required.')
      return
    }
    if (!PROPERTY_NAME_RE.test(name)) {
      setError('Not a valid CSS property name.')
      return
    }
    const key = toStorageKey(name)
    if (isCuratedProperty(key)) {
      setError('That property has a dedicated control in another section.')
      return
    }
    onChange(key as keyof CSSPropertyBag, value)
    setNewName('')
    setNewValue('')
    setError(null)
    setAdding(false)
  }

  // Nothing set AND not currently adding → still render the section so the
  // "Add property" affordance is discoverable; just no rows.
  const setCount = customKeys.length

  return (
    <Section
      title="Custom properties"
      icon={SlidersHorizontalIcon}
      defaultOpen={defaultOpen}
      flush
      indicator={setCount > 0}
      meta={setCount > 0 ? `${setCount} set` : undefined}
    >
      <div className={sectionStyles.sectionBody}>
        {customKeys.map((key) => {
          const value = storedStyles[key]
          return (
            <div key={key} className={styles.row} data-testid={`custom-property-row-${key}`}>
              <ControlRow propKey={key} label={displayName(key)}>
                <Input
                  id={`ctrl-${key}`}
                  fieldSize="sm"
                  value={String(value ?? '')}
                  aria-label={`${displayName(key)} value`}
                  onChange={(e) =>
                    onChange(key as keyof CSSPropertyBag, e.target.value || undefined)
                  }
                />
              </ControlRow>
              <Button
                variant="ghost"
                size="micro"
                iconOnly
                aria-label={`Remove ${displayName(key)}`}
                tooltip={`Remove ${displayName(key)}`}
                className={styles.removeBtn}
                onClick={() => onRemove(key as keyof CSSPropertyBag)}
              >
                <RemoveXGlyph />
              </Button>
            </div>
          )
        })}

        {adding ? (
          <div className={styles.addForm}>
            <div className={styles.addInputs}>
              <Input
                fieldSize="sm"
                value={newName}
                placeholder="property"
                aria-label="New property name"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setNewName(e.target.value)
                  setError(null)
                }}
              />
              <Input
                fieldSize="sm"
                value={newValue}
                placeholder="value"
                aria-label="New property value"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setNewValue(e.target.value)
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitNew()
                  }
                }}
              />
            </div>
            <div className={styles.addActions}>
              <Button variant="secondary" size="xs" onClick={() => { setAdding(false); setError(null) }}>
                Cancel
              </Button>
              <Button variant="primary" size="xs" onClick={commitNew} disabled={!newName.trim() || !newValue.trim()}>
                Add
              </Button>
            </div>
            {error && <p role="alert" className={styles.error}>{error}</p>}
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className={styles.addTrigger}
            onClick={() => setAdding(true)}
          >
            <PlusIcon size={14} aria-hidden="true" />
            Add property
          </Button>
        )}
      </div>
    </Section>
  )
}
