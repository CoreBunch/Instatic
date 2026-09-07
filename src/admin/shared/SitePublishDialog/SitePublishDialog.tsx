import { useState } from 'react'
import type { PublishVariantSelection } from '@core/localization-schema'
import { getCmsPublicationOverview } from '@core/persistence'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import s from './SitePublishDialog.module.css'

export function SitePublishDialog({ busy, onClose, onPublish }: {
  busy: boolean
  onClose: () => void
  onPublish: (selection: PublishVariantSelection) => Promise<boolean>
}) {
  const { data, loading, error, refresh } = useAsyncResource(getCmsPublicationOverview, [])
  const [choices, setChoices] = useState<Record<string, boolean>>({})
  const selected = data?.variants.filter((variant) => {
    const enabled = data.locales.some((locale) => locale.id === variant.localeId && locale.enabled)
    return enabled && (choices[`${variant.rowId}:${variant.localeId}`] ?? variant.availability === 'online')
  }) ?? []

  async function publish() {
    if (await onPublish({ variants: selected.map(({ rowId, localeId }) => ({ rowId, localeId })) })) onClose()
  }

  return <Dialog open onClose={onClose} title="Publish pages and languages" size="xl"
    closeOnEscape={!busy} closeOnBackdrop={!busy} hideCloseButton={busy}
    footer={<>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant="primary" disabled={busy || loading || selected.length === 0} onClick={() => void publish()}>
        {busy ? 'Publishing…' : `Publish ${selected.length} version${selected.length === 1 ? '' : 's'}`}
      </Button>
    </>}>
    <p className={s.description}>Choose page and template versions to publish. Page selections include their template dependencies. Other pages keep their current online or offline state. Republish CMS items to use an updated template.</p>
    {loading && <p role="status">Loading pages…</p>}
    {error && <div><p role="alert">{error}</p><Button variant="secondary" onClick={refresh}>Retry</Button></div>}
    <div className={s.languages}>
      {data?.locales.map((locale) => {
        const variants = data.variants.filter((variant) => variant.localeId === locale.id)
        return <section key={locale.id} className={s.language}>
          <div className={s.heading}><h3>{locale.name} <span>{locale.code}{locale.enabled ? '' : ' · Language offline'}</span></h3>
            <Button variant="ghost" size="sm" disabled={busy || !locale.enabled} onClick={() => setChoices((current) => ({
              ...current, ...Object.fromEntries(variants.map((variant) => [`${variant.rowId}:${locale.id}`, true])),
            }))}>Select all</Button>
          </div>
          {variants.map((variant) => {
            const key = `${variant.rowId}:${locale.id}`
            return <label key={key} className={s.row}>
              <Checkbox checked={locale.enabled && (choices[key] ?? variant.availability === 'online')}
                disabled={busy || !locale.enabled} onChange={(event) => setChoices({ ...choices, [key]: event.target.checked })} />
              <span className={s.title}>{variant.title || 'Untitled'}<small>{variant.isTemplate
                ? 'Template · no direct URL'
                : `/${locale.pathPrefix ? `${locale.pathPrefix}/` : ''}${variant.slug === 'index' ? '' : variant.slug}`}</small></span>
              <span className={s.state}>{variant.availability === 'online' ? 'Online' : 'Offline'}{variant.scheduledPublishAt ? ' · Scheduled' : ''}</span>
            </label>
          })}
        </section>
      })}
    </div>
  </Dialog>
}
