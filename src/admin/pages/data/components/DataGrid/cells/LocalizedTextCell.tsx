import { Select } from '@ui/components/Select'
import { useLocalizedData } from '@admin/pages/data/localizedData'
import { readLocalizedTextReference, resolveLocalizedTextValue } from '@core/data/localizedCells'
import { translationKeys, resolveTranslation } from '@core/localization'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { CellEditorProps } from '@admin/pages/data/types'
import type { DataField } from '@core/data/schemas'
import styles from './cells.module.css'

/** The row editor changes a key reference. Translation text is edited in its language file. */
export function LocalizedTextCell({ field, value, onChange, onCommit, readOnly, ariaLabel }: CellEditorProps<Extract<DataField, { type: 'localizedText' }>>) {
  const state = useLocalizedData()
  let key = ''
  let valueError: string | null = null
  let preview: string | null = null
  try {
    key = readLocalizedTextReference(value, `cells.${field.id}`)?.key ?? ''
    if (state?.context) preview = resolveLocalizedTextValue(value, state.context, `cells.${field.id}`)
  } catch (error) { valueError = getErrorMessage(error, 'Invalid language-catalogue reference') }
  const context = state?.context
  const options = context?.translations ? translationKeys(context.translations).map(key => ({
    value: key, label: `${key} — ${resolveTranslation(context.translations, key, context.language)}`,
  })) : []
  return <div>
    <Select aria-label={ariaLabel ?? `${field.label} catalogue key`} value={key}
      options={[{ value: '', label: 'No catalogue key', placeholder: true }, ...options]}
      placeholder="Choose catalogue key" searchable invalid={Boolean(valueError)} disabled={readOnly || !context}
      onChange={event => { onChange(event.target.value ? { key: event.target.value } : null); onCommit?.() }} />
    {!context && <span className={styles.empty}>Choose a content language to edit this reference.</span>}
    {preview !== null && <span className={styles.text}>{preview}</span>}
    {valueError && <span role="alert">{valueError}</span>}
    {context && state?.data?.canBrowseCatalogue === false && <span className={styles.empty}>Available keys come from content you can read. Site access is required to browse new keys.</span>}
  </div>
}
