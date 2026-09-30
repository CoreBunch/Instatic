import { useId, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { isSafeUrl } from '@core/html-sanitize'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { FormField } from '@ui/components/FormField'
import { Button } from '@ui/components/Button'
import { LinkTargetFields } from './LinkTargetFields'
import styles from './InsertLinkDialog.module.css'

export function InsertLinkDialog({ editor, position, onClose }: {
  editor: Editor
  position: number
  onClose: () => void
}) {
  const id = useId()
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [download, setDownload] = useState(false)
  const href = url.trim()
  const valid = href.length > 0 && isSafeUrl(href)

  return (
    <Dialog open title="Insert link" onClose={onClose} size="sm"
      footer={<Button type="submit" form={`${id}-form`} variant="primary" disabled={!valid}>Insert link</Button>}>
      <form id={`${id}-form`} className={styles.form} onSubmit={(event) => {
        event.preventDefault()
        if (!valid || editor.isDestroyed) return
        editor.chain().focus().insertContentAt(position, {
          type: 'text',
          text: text.trim() || href,
          marks: [{ type: 'link', attrs: { href, download: download ? '' : null } }],
        }).run()
        onClose()
      }}>
        <FormField label="Link text" htmlFor={`${id}-text`}>
          <Input id={`${id}-text`} autoFocus value={text} onChange={(event) => setText(event.target.value)} />
        </FormField>
        <FormField label="Link URL" htmlFor={`${id}-url`}>
          <Input id={`${id}-url`} value={url} placeholder="https:// or /page"
            invalid={href.length > 0 && !valid}
            onChange={(event) => setUrl(event.target.value)} />
        </FormField>
        <LinkTargetFields url={url} download={download} onDownloadChange={setDownload}
          onUrlChange={(value, filename) => { setUrl(value); if (!text.trim()) setText(filename) }} />
      </form>
    </Dialog>
  )
}
