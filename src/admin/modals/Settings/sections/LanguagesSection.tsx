import { useState } from 'react'
import type { Locale, LocaleInput } from '@core/localization-schema'
import { createCmsLocale, listCmsLocales, updateCmsLocale } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import s from './LanguagesSection.module.css'

export function LanguagesSection() {
  const { data: locales, loading, error, refresh } = useAsyncResource(listCmsLocales, [])
  const [adding, setAdding] = useState(false)

  function changed() {
    refresh()
    requestCmsSiteReload()
  }

  return (
    <div className={s.section}>
      <p className={s.description}>
        Share your site structure across languages. Translate content, URLs and metadata,
        then publish each page or entry independently. New languages start offline.
      </p>
      {loading && !locales && <p role="status">Loading languages…</p>}
      {error && <div><p role="alert">{error}</p><Button variant="secondary" onClick={refresh}>Retry</Button></div>}
      {locales?.map((locale) => (
        <LanguageForm key={`${locale.id}:${locale.code}:${locale.name}:${locale.pathPrefix}:${locale.enabled}:${locale.direction}`}
          locale={locale} onSaved={changed} />
      ))}
      {adding ? <LanguageForm onSaved={() => { setAdding(false); changed() }} onCancel={() => setAdding(false)} />
        : <Button variant="secondary" onClick={() => setAdding(true)}>Add language</Button>}
    </div>
  )
}

function LanguageForm({ locale, onSaved, onCancel }: {
  locale?: Locale
  onSaved: () => void
  onCancel?: () => void
}) {
  const [input, setInput] = useState<LocaleInput>(() => locale ? {
    code: locale.code, name: locale.name, pathPrefix: locale.pathPrefix,
    enabled: locale.enabled, direction: locale.direction,
  } : {
    code: '', name: '', pathPrefix: '', enabled: false, direction: 'ltr',
  })
  const [busy, setBusy] = useState(false)
  const formId = locale?.id ?? 'new'

  async function save() {
    setBusy(true)
    try {
      if (locale) await updateCmsLocale(locale.id, input)
      else await createCmsLocale(input)
      onSaved()
      pushToast({ kind: 'success', title: locale ? 'Language updated' : 'Language added' })
    } catch (err) {
      console.error('[LanguagesSection] failed to save language:', err)
      pushToast({ kind: 'error', title: 'Could not save language', body: getErrorMessage(err, 'Unknown language error') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={s.form} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <h4 className={s.heading}>{locale ? `${locale.name}${locale.isDefault ? ' · Source language' : ''}` : 'New language'}</h4>
      <div className={s.fields}>
        <label className={s.field} htmlFor={`${formId}-name`}>Name
          <Input id={`${formId}-name`} value={input.name} required placeholder="Deutsch"
            onChange={(event) => setInput({ ...input, name: event.target.value })} />
        </label>
        <label className={s.field} htmlFor={`${formId}-code`}>Language code
          <Input id={`${formId}-code`} value={input.code} required placeholder="de or de-AT"
            onChange={(event) => setInput({ ...input, code: event.target.value })} />
        </label>
        <label className={s.field} htmlFor={`${formId}-prefix`}>URL prefix
          <Input id={`${formId}-prefix`} value={input.pathPrefix} disabled={locale?.isDefault} placeholder="de"
            required={!locale?.isDefault} onChange={(event) => setInput({ ...input, pathPrefix: event.target.value })} />
        </label>
        <label className={s.field} htmlFor={`${formId}-direction`}>Text direction
          <Select id={`${formId}-direction`} value={input.direction}
            options={[{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' }]}
            onChange={(event) => setInput({ ...input, direction: event.target.value === 'rtl' ? 'rtl' : 'ltr' })} />
        </label>
      </div>
      {locale && <div className={s.availability}>
        <div><label htmlFor={`${formId}-enabled`}>Language online</label>
          <p className={s.description}>Only published pages and entries appear online. Turning this off hides this whole language.</p>
        </div>
        <Switch id={`${formId}-enabled`} checked={input.enabled} disabled={busy}
          onCheckedChange={(enabled) => setInput({ ...input, enabled })} />
      </div>}
      <div className={s.actions}>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : locale ? 'Save language' : 'Add language'}</Button>
        {onCancel && <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  )
}
