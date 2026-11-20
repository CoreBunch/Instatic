import { lazy, Suspense, useRef, useState, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import styles from './controls.module.css'

const FrameworkColorPicker = lazy(() => import('@site/property-controls/FrameworkColorPicker'))

export function InspectorColorSwatch({ label, value, preview, disabled, onChange }: {
  label: string
  value: string
  preview: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const picker = <FrameworkColorPicker value={value} onChange={onChange} />
  const close = () => setOpen(false)
  return <>
    <Button ref={anchor} variant="ghost" size="micro" iconOnly className={styles.colorInlineSwatch}
      aria-label={label} aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
      <span className={styles.inspectorColorChip} style={{ '--preview-color': preview || 'transparent' } as CSSProperties} />
    </Button>
    {open && <Suspense fallback={null}>
      <FloatingPanel anchorRef={anchor} title={label} closeLabel="Close color editor" width={286}
        onClose={close}>{picker}</FloatingPanel>
    </Suspense>}
  </>
}
