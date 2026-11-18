/**
 * Who may open a table's entry pages on the published site.
 *
 * Unlike the rest of the table settings this is not saved field by field: a
 * change takes effect on the live site at once, so it is made deliberately
 * with a Save button, behind the password prompt.
 */
import { useState, type ReactElement } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { AccessRuleEditor, isCompleteAccessRule } from '@admin/shared/AccessRuleEditor'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import type { DataTable } from '@core/data/schemas'
import type { AccessRule } from '@core/members'
import { getCmsDataTableAccess, setCmsDataTableAccess } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import sectionStyles from '@ui/components/Section/Section.module.css'
import { pushToast } from '@ui/components/Toast'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import styles from './DataInspector.module.css'

export function TableAccessSection({ table, canEdit }: { table: DataTable; canEdit: boolean }): ReactElement {
  const { runStepUp } = useStepUp()
  const { data: saved, error, refresh } = useAsyncResource(
    (signal) => getCmsDataTableAccess(table.id, signal),
    [table.id],
    { fallbackError: 'Could not load who can open this table.' },
  )
  // The rule being edited, kept per table so switching tables starts clean.
  const [edit, setEdit] = useState<{ tableId: string; rule: AccessRule } | null>(null)
  const [saving, setSaving] = useState(false)
  const draft = edit?.tableId === table.id ? edit.rule : saved
  const dirty = saved !== null && draft !== null && JSON.stringify(saved) !== JSON.stringify(draft)

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      await runStepUp(() => setCmsDataTableAccess(table.id, draft))
      setEdit(null)
      refresh()
      pushToast({ kind: 'success', title: 'Access changed', body: 'It applies on the published site now.' })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[TableAccessSection] saving table access failed:', err)
      pushToast({ kind: 'error', title: 'Could not change access', body: getErrorMessage(err, 'Unknown access error') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title="Access" icon={LockSolidIcon}>
      <div className={sectionStyles.sectionBody}>
        {error && <p role="alert" className={styles.errorBanner}>{error}</p>}
        {draft && (
          <>
            <AccessRuleEditor
              value={draft}
              onChange={(rule) => setEdit({ tableId: table.id, rule })}
              disabled={!canEdit || saving}
              subject={`${table.pluralLabel.toLowerCase()} pages`}
            />
            <p className={styles.accessHint}>
              {canEdit
                ? 'Covers every entry page of this table, and leaves closed entries out of lists. A change applies on the published site at once; pages are rendered on request until the next publish.'
                : 'You do not have permission to change who can open this table.'}
            </p>
            {canEdit && (
              <div className={styles.accessActions}>
                {dirty && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEdit(null)} disabled={saving}>
                    Discard
                  </Button>
                )}
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void save()}
                  disabled={!dirty || !isCompleteAccessRule(draft)}
                  busy={saving}
                >
                  Save access
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  )
}
