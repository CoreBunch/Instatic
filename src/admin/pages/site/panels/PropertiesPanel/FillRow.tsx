import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { resolveColorPreview } from '@site/property-controls/frameworkColorPreview'
import type { CSSPropertyBag } from '@core/page-tree'
import { SwatchRow } from '@ui/components/SwatchRow'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { LabeledControl } from './LayoutSection/LabeledControl'
import { useEditorStore } from '@site/store/store'

const FrameworkColorPicker = lazy(() => import('@site/property-controls/FrameworkColorPicker'))

const gradientPattern = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i

interface FillRowProps {
  current: Record<string, unknown>
  stored: Record<string, unknown>
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
}

export function FillRow({ current, stored, onChangeMany }: FillRowProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const setPickerOpen = useEditorStore((s) => s.setGradientPickerOpen)
  const colors = useEditorStore((s) => s.site?.settings.framework?.colors)
  const tokens = generateFrameworkColorVariableSets(colors).light
  const image = String(current.backgroundImage ?? '')
  const gradient = gradientPattern.test(image)
  const fill = gradient ? image : String(current.backgroundColor ?? '')
  const preview = resolveColorPreview(fill, tokens)
  const name = gradient ? image.slice(0, image.indexOf('(')).replaceAll('-', ' ') : fill
  const set = Boolean(stored.backgroundColor || gradientPattern.test(String(stored.backgroundImage ?? '')))
  useEffect(() => {
    if (!open) return
    setPickerOpen(true)
    return () => setPickerOpen(false)
  }, [open, setPickerOpen])

  function change(value: string) {
    // A solid behind a URL image is valid. Only replace the image layer when switching away from a gradient.
    const patch = gradientPattern.test(value)
      ? { backgroundImage: value }
      : { backgroundColor: value, ...(gradient ? { backgroundImage: 'none' } : {}) }
    onChangeMany(patch)
  }

  return (
    <div data-testid="css-property-row-backgroundColor">
      <LabeledControl label="Fill" isSet={set}>
        <SwatchRow triggerRef={trigger} name={name || 'Add…'} isSet={Boolean(fill)}
          chipStyle={{ '--swatch-chip-fill': preview || 'transparent' } as CSSProperties}
          ariaLabel="Edit fill" ariaExpanded={open} onClick={() => setOpen(!open)}
          onClear={set ? () => onChangeMany({
            ...(stored.backgroundColor ? { backgroundColor: undefined } : {}),
            ...(gradientPattern.test(String(stored.backgroundImage ?? '')) ? { backgroundImage: undefined } : {}),
          }) : undefined} clearLabel="Clear fill" />
      </LabeledControl>
      {open && <Suspense fallback={null}><FloatingPanel open anchorRef={trigger} onClose={() => setOpen(false)}
        title="Fill" closeLabel="Close fill editor" width={286} estimatedHeight={470}
        keepOpenSelector="[data-color-picker-keep-open]">
        <Suspense fallback={<span role="status">Loading fill editor…</span>}>
          <FrameworkColorPicker gradients value={fill} onChange={change} />
        </Suspense>
      </FloatingPanel></Suspense>}
    </div>
  )
}
