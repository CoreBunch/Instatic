import { useId } from 'react'
import type { FieldLocalization } from '@core/localization-schema'
import { Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import styles from './NewFieldDialog.module.css'

export function FieldAuthoringSettings({ description, required, localization, localizationLocked, onDescriptionChange, onRequiredChange, onLocalizationChange }: {
  description: string; required: boolean; localization: FieldLocalization; localizationLocked: boolean
  onDescriptionChange: (value: string) => void; onRequiredChange: (value: boolean) => void
  onLocalizationChange: (value: FieldLocalization) => void
}) {
  const formId = useId()
  const descriptionInputId = useId()
  return (
        <section className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <h3>Authoring</h3>
            <p>Set the expectations and guidance shown when someone edits a record.</p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${formId}-localization`}>Languages</label>
            <Select id={`${formId}-localization`} value={localization}
              disabled={localizationLocked}
              options={[{ value: 'localized', label: 'Translate per language' }, { value: 'shared', label: 'Share across all languages' }]}
              onChange={(event) => onLocalizationChange(event.target.value === 'shared' ? 'shared' : 'localized')} />
            <span className={styles.caption}>{localizationLocked && localization === 'localized'
              ? 'URL slugs are managed separately for each language.'
              : 'Shared fields use one value everywhere. Translated fields inherit the source until you override them.'}</span>
          </div>

          <div className={styles.wideNarrowRow}>
            <div className={styles.field}>
              <label htmlFor={descriptionInputId} className={styles.label}>Description <span className={styles.optional}>(optional)</span></label>
              <Textarea
                id={descriptionInputId}
                fieldSize="sm"
                value={description}
                onChange={(event) => onDescriptionChange(event.target.value)}
                placeholder="Shown next to the field in the editor"
                rows={2}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Required</span>
              <div className={styles.switchControl}>
                <Switch
                  checked={required}
                  onCheckedChange={onRequiredChange}
                  aria-label="Required"
                />
              </div>
            </div>
          </div>
        </section>
  )
}
