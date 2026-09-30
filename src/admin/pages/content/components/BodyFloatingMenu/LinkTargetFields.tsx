import { useId, useState } from 'react'
import { MediaPickerModal } from '@admin/pages/media/components/MediaPickerModal/MediaPickerModal'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { FormField } from '@ui/components/FormField'
import styles from './LinkTargetFields.module.css'

export function LinkTargetFields({ url, download, onUrlChange, onDownloadChange }: {
  url: string
  download: boolean
  onUrlChange: (url: string, filename: string) => void
  onDownloadChange: (download: boolean) => void
}) {
  const [picking, setPicking] = useState(false)
  const id = useId()
  return <>
    <div className={styles.fields}>
      <Button type="button" variant="secondary" size="md" className={styles.libraryButton}
        onClick={() => setPicking(true)}>Media library</Button>
      <FormField label="Link action" htmlFor={id}>
        <Select id={id} value={download ? 'download' : 'open'}
          onChange={(event) => onDownloadChange(event.target.value === 'download')}>
          <option value="open">Open</option>
          <option value="download">Download</option>
        </Select>
      </FormField>
    </div>
    <MediaPickerModal open={picking} mediaKind="any" currentValue={url}
      onClose={() => setPicking(false)} onPick={(asset) => {
        onUrlChange(asset.publicPath, asset.filename)
        setPicking(false)
      }} />
  </>
}
