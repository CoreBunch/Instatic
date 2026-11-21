import { lazy, Suspense, useState } from 'react'
import { MediaPickerField } from '@admin/pages/media/components/MediaPickerField'
import { primeCmsMediaAssetCache, useCmsMediaAssetByPath } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import styles from './PageSeoEditor.module.css'

const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then((module) => ({ default: module.MediaPickerModal })),
)

const sources = [
  { value: 'library', label: 'Library' },
  { value: 'url', label: 'URL' },
] as const

export function SeoImageField({ label, value = '', inherited, hint, onChange }: {
  label: string
  value?: string
  inherited?: string
  hint?: string
  onChange: (value: string) => void
}) {
  const [source, setSource] = useState<'library' | 'url'>(() => value && !value.startsWith('/uploads/') ? 'url' : 'library')
  const [open, setOpen] = useState(false)
  const displayed = value || inherited || ''
  const asset = useCmsMediaAssetByPath(displayed.startsWith('/uploads/') ? displayed : null)

  return (
    <div className={styles.row} role="group" aria-label={label}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>
        <SegmentedControl value={source} options={sources} onChange={setSource} aria-label={`${label} source`} size="sm" />
        {source === 'library' ? (
          <MediaPickerField mediaKind="image" asset={asset} hasValue={Boolean(displayed)} fallbackLabel={displayed}
            onBrowse={() => setOpen(true)} onClear={value ? () => onChange('') : undefined} />
        ) : (
          <Input fieldSize="sm" aria-label={`${label} URL`} value={value} placeholder={inherited} maxLength={2048}
            onChange={(event) => onChange(event.target.value)} />
        )}
        {!value && inherited && <p className={styles.hint}>Inherited image</p>}
        {hint && <p className={styles.hint}>{hint}</p>}
      </div>
      {open && (
        <Suspense fallback={null}>
          <MediaPickerModal open onClose={() => setOpen(false)} mediaKind="image" currentValue={value}
            onPick={(picked) => {
              primeCmsMediaAssetCache(picked)
              onChange(picked.publicPath)
            }} />
        </Suspense>
      )}
    </div>
  )
}
