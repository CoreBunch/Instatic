import { useState } from 'react'
import type { DataRow } from '@core/data/schemas'
import { getTranslationFieldState, resolveDataFieldLocalization } from '@core/localization'
import { changeCmsTranslation, getCmsRowLocalizations } from '@core/persistence'
import { publishCmsDataRow, updateCmsDataRowStatus } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { notifyCmsPublicationChanged } from '@admin/state/adminEvents'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import s from './ContentLanguagesDialog.module.css'

const STATE_LABELS = { missing: 'Missing', inherited: 'Inherited from source', needs_review: 'Needs review', reviewed: 'Reviewed' }

export function ContentLanguagesDialog({ rowId, localeId, canPublish, canEdit, onClose, onEditLanguage, onUpdated }: {
  rowId: string
  localeId: string
  canPublish: boolean
  canEdit: boolean
  onClose: () => void
  onEditLanguage: (localeId: string) => void
  onUpdated?: (row: DataRow) => void
}) {
  const { runStepUp } = useStepUp()
  const { data, loading, error, refresh } = useAsyncResource(() => getCmsRowLocalizations(rowId), [rowId])
  const [inspectedLocaleId, setInspectedLocaleId] = useState(localeId)
  const [busy, setBusy] = useState(false)
  const sourceLocale = data?.locales.find((locale) => locale.isDefault)
  const source = data?.rows.find((row) => row.localeId === sourceLocale?.id)
  const inspected = data?.rows.find((row) => row.localeId === inspectedLocaleId)
  const fields = data?.fields.filter((field) => resolveDataFieldLocalization(field) === 'localized') ?? []

  async function change(operation: () => Promise<DataRow>) {
    setBusy(true)
    try {
      const row = await runStepUp(operation)
      onUpdated?.(row)
      notifyCmsPublicationChanged()
      refresh()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[ContentLanguagesDialog] failed to update translation:', err)
      pushToast({ kind: 'error', title: 'Could not update translation', body: getErrorMessage(err, 'Unknown translation error') })
    } finally {
      setBusy(false)
    }
  }

  return <Dialog open onClose={onClose} title="Languages and publication" size="2xl">
    <p className={s.description}>Each language has its own draft and published version. Inherited text is visible while editing; publish a version to put it online.</p>
    {loading && !data && <p role="status">Loading languages…</p>}
    {error && <div><p role="alert">{error}</p><Button variant="secondary" onClick={refresh}>Retry</Button></div>}
    {data && <div className={s.tableWrap}><table className={s.table}>
      <thead><tr><th>Language</th><th>Translation</th><th>Online</th><th>Actions</th></tr></thead>
      <tbody>{data.locales.map((locale) => {
        const row = data.rows.find((candidate) => candidate.localeId === locale.id)
        if (!row) return null
        const inherited = fields.filter((field) => !Object.hasOwn(row.localization?.cells ?? {}, field.id)).length
        const online = row.localization?.availability === 'online'
        return <tr key={locale.id}>
          <td>{locale.name}<small>{locale.code}{locale.isDefault ? ' · Source' : ''}</small></td>
          <td>{locale.isDefault ? 'Source content' : `${fields.length - inherited} / ${fields.length} fields translated`}
            {row.scheduledPublishAt && <small>Scheduled: {new Date(row.scheduledPublishAt).toLocaleString()}</small>}
          </td>
          <td><Switch aria-label={`${locale.name} online`} checked={online}
            disabled={busy || !canPublish || (!locale.enabled && !online)}
            onCheckedChange={(next) => void change(() => next
              ? publishCmsDataRow(rowId, undefined, undefined, locale.id)
              : updateCmsDataRowStatus(rowId, 'unpublished', undefined, undefined, locale.id))} />
            {!locale.enabled && <small>Language offline</small>}
          </td>
          <td><div className={s.actions}>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setInspectedLocaleId(locale.id)}>Details</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => { onEditLanguage(locale.id); onClose() }}>Open</Button>
            {online && locale.enabled && row.publicPath && <Button variant="ghost" size="sm"
              onClick={() => window.open(row.publicPath ?? '/', '_blank', 'noopener,noreferrer')}>View live</Button>}
          </div></td>
        </tr>
      })}</tbody>
    </table></div>}
    {inspected && source && inspected.localeId !== source.localeId && <section className={s.details}>
      <h3>{data?.locales.find((locale) => locale.id === inspected.localeId)?.name} · Translation details</h3>
      {fields.map((field) => {
        const state = getTranslationFieldState(source.cells, inspected.localization?.cells ?? {}, field.id, inspected.localization?.translationMeta[field.id])
        const translated = state === 'needs_review' || state === 'reviewed'
        return <div key={field.id} className={s.field}>
          <div>{field.label}<small>{STATE_LABELS[state]}</small></div>
          <div className={s.actions}>
            <Button variant="ghost" size="sm" disabled={busy || !canEdit || !translated}
              onClick={() => void change(() => changeCmsTranslation(rowId, inspected.localeId, { action: 'reset', fieldId: field.id }))}>Use source</Button>
            <Button variant="secondary" size="sm" disabled={busy || !canEdit || !translated || state === 'reviewed'}
              onClick={() => void change(() => changeCmsTranslation(rowId, inspected.localeId, { action: 'review', fieldId: field.id }))}>Mark reviewed</Button>
          </div>
        </div>
      })}
    </section>}
  </Dialog>
}
