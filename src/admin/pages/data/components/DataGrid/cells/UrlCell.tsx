import type { ReactElement } from 'react'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { readStringCell } from '@core/data/cells'
import type { CellEditorProps } from '@admin/pages/data/types'
import type { DataField } from '@core/data/schemas'
import styles from './cells.module.css'

type UrlField = Extract<DataField, { type: 'url' }>

export function UrlCell({
  field,
  value,
  onChange,
  onCommit,
  readOnly,
  context,
  ariaLabel,
}: CellEditorProps<UrlField>): ReactElement {
  const strValue = typeof value === 'string' ? value : readStringCell({ [field.id]: value }, field.id)
  const hasUrl = strValue.trim().length > 0

  return (
    <div className={styles.urlWrapper}>
      <Input
        className={styles.inputFull}
        type="url"
        value={strValue}
        readOnly={readOnly}
        aria-label={ariaLabel ?? field.label}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit?.()}
        onKeyDown={(e) => { if (e.key === 'Enter') onCommit?.() }}
      />
      {context === 'detail' && hasUrl && (
        <Button
          variant="ghost"
          size="md"
          iconOnly
          tooltip="Open URL in new tab"
          aria-label="Open URL in new tab"
          className={styles.urlLinkBtn}
          onClick={() => window.open(strValue, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLinkSolidIcon size={14} />
        </Button>
      )}
    </div>
  )
}
