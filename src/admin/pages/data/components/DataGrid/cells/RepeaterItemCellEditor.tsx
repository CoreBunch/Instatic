import type { ReactElement } from 'react'
import type { RepeaterItemField } from '@core/data/schemas'
import type { CellEditorProps } from '@admin/pages/data/types'
import type { RelationCellProps } from './RelationCell'
import { BooleanCell } from './BooleanCell'
import { DateCell } from './DateCell'
import { DateTimeCell } from './DateTimeCell'
import { EmailCell } from './EmailCell'
import { LongTextCell } from './LongTextCell'
import { MediaCell } from './MediaCell'
import { MultiSelectCell } from './MultiSelectCell'
import { NumberCell } from './NumberCell'
import { RelationCell } from './RelationCell'
import { RichTextCell } from './RichTextCell'
import { SelectCell } from './SelectCell'
import { TextCell } from './TextCell'
import { UrlCell } from './UrlCell'

type RepeaterItemCellEditorProps = CellEditorProps<RepeaterItemField> & {
  onOpenPicker?: RelationCellProps['onOpenPicker']
}

/**
 * Repeater items intentionally support only ordinary value fields. Keeping
 * their dispatcher separate prevents the recursive top-level dispatcher from
 * importing the repeater editor that calls it.
 */
export function RepeaterItemCellEditor({
  field,
  onOpenPicker,
  ...rest
}: RepeaterItemCellEditorProps): ReactElement {
  switch (field.type) {
    case 'text':
      return <TextCell field={field} {...rest} />
    case 'longText':
      return <LongTextCell field={field} {...rest} />
    case 'richText':
      return <RichTextCell field={field} {...rest} />
    case 'number':
      return <NumberCell field={field} {...rest} />
    case 'boolean':
      return <BooleanCell field={field} {...rest} />
    case 'date':
      return <DateCell field={field} {...rest} />
    case 'dateTime':
      return <DateTimeCell field={field} {...rest} />
    case 'select':
      return <SelectCell field={field} {...rest} />
    case 'multiSelect':
      return <MultiSelectCell field={field} {...rest} />
    case 'url':
      return <UrlCell field={field} {...rest} />
    case 'email':
      return <EmailCell field={field} {...rest} />
    case 'media':
      return <MediaCell field={field} {...rest} />
    case 'relation':
      return <RelationCell field={field} {...rest} onOpenPicker={onOpenPicker} />
    default: {
      const _exhaustive: never = field
      void _exhaustive
      return <span />
    }
  }
}
