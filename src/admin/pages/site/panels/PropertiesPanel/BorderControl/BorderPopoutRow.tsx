import { lazy, Suspense, useRef, useState, type CSSProperties } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { useEditorStore } from '@site/store/store'
import { resolveColorPreview } from '@ui/lib/colorVariable'
import { SwatchRow } from '@ui/components/SwatchRow'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { SIDES, borderKey } from './borderSides'
import styles from './BorderPopoutRow.module.css'

const BorderControl = lazy(() => import('./BorderControl').then((module) => ({ default: module.BorderControl })))

interface BorderPopoutRowProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  /** Breakpoint tab id — the editor remounts per tab, like the other rows. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** Several properties in one commit — the first-open seed is one undo step. */
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

/**
 * What the first click on an empty Border row writes: a visible 1px solid
 * white border on every side. A popout full of empty fields tells the user
 * nothing; a border they can SEE, then change, does — the same reason
 * "Add effect" drops a real shadow instead of a blank row.
 */
function seedBorder(): Partial<CSSPropertyBag> {
  const patch: Record<string, string> = {}
  for (const side of SIDES) {
    patch[`border${side}Width`] = '1px'
    patch[`border${side}Style`] = 'solid'
    patch[`border${side}Color`] = '#ffffff'
  }
  return patch
}

function readFirstSet(styles: Record<string, unknown>, field: 'Style' | 'Color'): string {
  for (const side of SIDES) {
    const value = styles[borderKey(side, field)]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

export function BorderPopoutRow({
  storedStyles,
  currentStyles,
  activeTab,
  onChange,
  onChangeMany,
  onPreview,
  onClearPreview,
}: BorderPopoutRowProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const style = readFirstSet(currentStyles, 'Style')
  const palette = useEditorStore((s) => s.site?.settings.framework?.colors)
  const color = resolveColorPreview(readFirstSet(currentStyles, 'Color'), generateFrameworkColorVariableSets(palette).light)
  const isBorderProperty = (key: string) =>
    /^(border(?:$|Top|Right|Bottom|Left|Style|Width|Color)|outline)/.test(key) && !key.endsWith('Radius')
  const storedKeys = Object.keys(storedStyles).filter(isBorderProperty)
  const isSet = Object.entries(currentStyles).some(([key, value]) => isBorderProperty(key) && value != null && value !== '')

  // Title-case the CSS keyword for the row summary ("solid" → "Solid").
  const summary = style === '' ? (isSet ? 'Custom' : 'Add…') : style.charAt(0).toUpperCase() + style.slice(1)

  function clearBorder() {
    const patch = Object.fromEntries(storedKeys.map((key) => [key, null]))
    onChangeMany(patch)
  }

  return (
    <>
      <SwatchRow
        name={summary}
        isSet={isSet}
        // The chip paints the stored colour as a ring; an unset border falls
        // back to the panel's own hairline so it is still visible.
        chipStyle={
          {
            '--swatch-chip-ring': `inset 0 0 0 2px ${color || 'var(--border-strong)'}, inset 0 0 0 3px var(--overlay-20)`,
          } as CSSProperties
        }
        triggerRef={triggerRef}
        onClick={() => {
          // An empty row's first click puts a border on the element right
          // away; the popout then opens on something to adjust.
          if (!isSet && !open) onChangeMany(seedBorder())
          setOpen((current) => !current)
        }}
        ariaExpanded={open}
        ariaLabel={isSet ? `Edit border — ${summary}` : 'Add a border'}
        onClear={storedKeys.length ? clearBorder : undefined}
        clearLabel="Clear border"
      />

      {open && <Suspense fallback={null}><FloatingPanel
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        title="Border"
        closeLabel="Close border editor"
        // Wider than the default popout: the Width row carries number ⊕ unit
        // ⊕ the two scope tiles beside a 52px label, and at 244px the number
        // field had no room left.
        width={288}
      >
        <div className={styles.popoutBody}>
          <Suspense fallback={null}><BorderControl
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChangeMany={onChangeMany}
            onChange={onChange}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          /></Suspense>
        </div>
      </FloatingPanel></Suspense>}
    </>
  )
}
