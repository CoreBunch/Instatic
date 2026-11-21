import { gradientLayer } from '@site/property-controls/gradientLayer'
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { resolveColorPreview } from '@ui/lib/colorVariable'
import type { CSSPropertyBag } from '@core/page-tree'
import { SwatchRow } from '@ui/components/SwatchRow'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { isGradientImage } from '@ui/lib/cssValueList'
import { LabeledControl } from './LayoutSection/LabeledControl'
import { useEditorStore } from '@site/store/store'

const FrameworkColorPicker = lazy(() => import('@site/property-controls/FrameworkColorPicker'))

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
  const layer = gradientLayer(current.backgroundImage)
  const gradient = layer.value
  const fill = gradient ?? String(current.backgroundColor ?? '')
  const preview = resolveColorPreview(fill, tokens)
  const name = gradient ? gradient.slice(0, gradient.indexOf('(')).replaceAll('-', ' ') : fill
  const storedGradient = Boolean(gradientLayer(stored.backgroundImage).value)
  const set = gradient ? storedGradient : Boolean(stored.backgroundColor)
  useEffect(() => {
    if (!open) return
    setPickerOpen(true)
    return () => setPickerOpen(false)
  }, [open, setPickerOpen])

  function change(value: string) {
    if (isGradientImage(value)) {
      onChangeMany({ backgroundImage: layer.replace(value) })
    } else {
      onChangeMany({ backgroundColor: value, ...(gradient ? { backgroundImage: layer.replace(null) || 'none' } : {}) })
    }
  }

  return (
    <div data-testid="css-property-row-backgroundColor">
      <LabeledControl label="Fill" isSet={set}>
        <SwatchRow triggerRef={trigger} name={name || 'Add…'} isSet={Boolean(fill)}
          chipStyle={{ '--swatch-chip-fill': preview || 'transparent' } as CSSProperties}
          ariaLabel="Edit fill" ariaExpanded={open} onClick={() => setOpen(!open)}
          onClear={set ? () => onChangeMany(gradient
            ? { backgroundImage: layer.replace(null) || undefined }
            : { backgroundColor: undefined }) : undefined} clearLabel="Clear fill" />
      </LabeledControl>
      {open && <Suspense fallback={null}><FloatingPanel anchorRef={trigger} onClose={() => setOpen(false)}
        title="Fill" closeLabel="Close fill editor" width={286}
        keepOpenSelector="[data-color-picker-keep-open]">
        <Suspense fallback={<span role="status">Loading fill editor…</span>}>
          <FrameworkColorPicker gradients value={fill} onChange={change} />
        </Suspense>
      </FloatingPanel></Suspense>}
    </div>
  )
}
