import { Type } from '@sinclair/typebox'
import { RowAttachmentSchema, type RowAttachment } from '@core/data/attachments'
import { apiRequest, apiBlobRequest } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import styles from './DataInspector.module.css'

const Envelope = Type.Object({ attachments: Type.Array(RowAttachmentSchema) })

export function RowAttachments({ rowId }: { rowId: string }) {
  const path = `/admin/api/cms/data/rows/${encodeURIComponent(rowId)}/attachments`
  const resource = useAsyncResource(
    (signal) => apiRequest(path, { schema: Envelope, signal }),
    [rowId],
    { fallbackError: 'Could not load attachments.' },
  )
  async function download(file: RowAttachment) {
    try {
      const blob = await apiBlobRequest(`${path}/${encodeURIComponent(file.id)}`)
      if (blob.type !== 'application/octet-stream') throw new Error('Invalid attachment response')
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.filename
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      pushToast({ kind: 'error', title: 'Download failed', body: getErrorMessage(err, 'Could not download attachment.') })
    }
  }
  if (resource.error) return <div className={styles.section}><p role="status">{resource.error}</p><Button variant="ghost" onClick={resource.refresh}>Retry attachments</Button></div>
  if (!resource.data?.attachments.length) return null
  return (
    <section className={styles.section} aria-label="Private attachments">
      <h3>Private attachments</h3>
      {resource.data.attachments.map((file) => (
        <Button variant="ghost" key={file.id} onClick={() => download(file)} aria-label={`Download ${file.filename}`}>
          {file.filename} ({Math.ceil(file.sizeBytes / 1024)} KB)
        </Button>
      ))}
    </section>
  )
}
