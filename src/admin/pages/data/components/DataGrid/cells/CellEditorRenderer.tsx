import type { ReactElement } from 'react'
import type { DataField, DataTable } from '@core/data/schemas'
import type { CellEditorProps } from '@admin/pages/data/types'
import type { RelationCellProps } from './RelationCell'
import type { PageTreeCellProps } from './PageTreeCell'
import type { FieldSchemaCellProps } from './FieldSchemaCell'
import { TextCell } from './TextCell'
import { LongTextCell } from './LongTextCell'
import { RichTextCell } from './RichTextCell'
import { NumberCell } from './NumberCell'
import { BooleanCell } from './BooleanCell'
import { DateCell } from './DateCell'
import { DateTimeCell } from './DateTimeCell'
import { SelectCell } from './SelectCell'
import { MultiSelectCell } from './MultiSelectCell'
import { UrlCell } from './UrlCell'
import { EmailCell } from './EmailCell'
import { MediaCell } from './MediaCell'
import { RelationCell } from './RelationCell'
import { PageTreeCell } from './PageTreeCell'
import { FieldSchemaCell } from './FieldSchemaCell'
import { RepeaterCell } from './RepeaterCell'


/**
 * Additional props that are only meaningful for specific cell types but are
 * threaded through the renderer so callers don't have to special-case them.
 */
interface CellEditorRendererExtras {
  /** Forwarded to RelationCell — opens the relation picker dialog. */
  onOpenPicker?: RelationCellProps['onOpenPicker']
  /** Forwarded to PageTreeCell — opens the visual editor for this row. */
  onOpenEditor?: PageTreeCellProps['onOpenEditor']
  /** Forwarded to FieldSchemaCell — opens the field-editor dialog. */
  onOpenFieldEditor?: FieldSchemaCellProps['onOpenFieldEditor']
  /** Forwarded to RepeaterCell for nested relation fields. */
  tables?: DataTable[]
}

type CellEditorRendererProps = CellEditorProps<DataField> & CellEditorRendererExtras

/**
 * Dispatches to the appropriate cell editor based on `field.type`.
 * All cell editors share the same `CellEditorProps` contract; this component
 * is the sole place that narrows `DataField` to a concrete variant.
 */
export function CellEditorRenderer({
  field,
  onOpenPicker,
  onOpenEditor,
  onOpenFieldEditor,
  tables,
  ...rest
}: CellEditorRendererProps): ReactElement {
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

    case 'repeater':
      return <RepeaterCell field={field} {...rest} tables={tables} />

    case 'pageTree':
      return <PageTreeCell field={field} {...rest} onOpenEditor={onOpenEditor} />

    case 'fieldSchema':
      return <FieldSchemaCell field={field} {...rest} onOpenFieldEditor={onOpenFieldEditor} />

    default: {
      // Exhaustive check: TypeScript will error here if a new field type
      // is added to the discriminated union without a case above.
      const _exhaustive: never = field
      void _exhaustive
      return <span />
    }
  }
}
