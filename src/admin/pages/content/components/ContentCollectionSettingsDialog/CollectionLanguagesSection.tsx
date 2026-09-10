import { useState } from 'react'
import type { Locale, TableLocalization } from '@core/localization-schema'
import { getCmsTableLocalizations, updateCmsTableLocalization } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import styles from './CollectionLanguagesSection.module.css'

function LanguagePath({ tableId, locale, routeBase, onSaved }: {
  tableId: string; locale: Locale; routeBase: string; onSaved: () => void
}) {
  const [path, setPath] = useState(routeBase)
  const [busy, setBusy] = useState(false)
  const { runStepUp } = useStepUp()
  async function save() {
    setBusy(true)
    try {
      await runStepUp(() => updateCmsTableLocalization(tableId, locale.id, path))
      onSaved()
      pushToast({ kind: 'success', title: `${locale.name} URL path saved`, body: 'Publish the entries to apply the new address.' })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      pushToast({ kind: 'error', title: 'Could not save URL path', body: getErrorMessage(err, 'Unknown collection error') })
    } finally {
      setBusy(false)
    }
  }
  return <div className={styles.row}>
    <label className={styles.field}>
      <span>{locale.name} · /{locale.pathPrefix}</span>
      <Input fieldSize="sm" value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} />
    </label>
    <Button variant="secondary" size="sm" type="button" disabled={busy || path === routeBase} onClick={() => void save()}>Save path</Button>
  </div>
}

export function CollectionLanguagesSection({ tableId, routeBase }: { tableId: string; routeBase: string }) {
  const resource = useAsyncResource(() => getCmsTableLocalizations(tableId), [tableId])
  function pathFor(locale: Locale, localizations: TableLocalization[]) {
    return localizations.find((item) => item.localeId === locale.id)?.routeBase ?? routeBase
  }
  return <section className={styles.section} aria-label="Translated collection URLs">
    <h3>Translated URL paths</h3>
    <p>The language prefix is added automatically. Published entries keep their current address until you publish them again.</p>
    {resource.error && <p role="alert">{resource.error}</p>}
    {resource.data?.locales.filter((locale) => !locale.isDefault).map((locale) => <LanguagePath
      key={`${locale.id}:${pathFor(locale, resource.data!.localizations)}`}
      tableId={tableId} locale={locale} routeBase={pathFor(locale, resource.data!.localizations)} onSaved={resource.refresh} />)}
    {resource.data?.locales.length === 1 && <p>Add languages in Settings to translate collection addresses.</p>}
  </section>
}
