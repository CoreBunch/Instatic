import { SourceLocaleNotice, useEditorLocale } from '@site/localization'
/**
 * PublishingSection — self-hosted CMS publishing details.
 */
import { useSiteSettingsController } from '../useSiteSettingsController'
import { resolveFrameworkPreferences } from '@core/framework'
import { Switch } from '@ui/components/Switch'
import { Input } from '@ui/components/Input'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { useState } from 'react'
import { normalizePublicOrigin } from '@core/localization-routing'
import { getErrorMessage } from '@core/utils/errorMessage'
import s from '../SettingsModal.module.css'

export function PublishingSection() {
  const { site, error, updateFrameworkPreferences, updateSiteSettings } = useSiteSettingsController()
  const [originError, setOriginError] = useState<string | null>(null)

  function savePublicOrigin(value: string) {
    let publicOrigin: string | undefined
    try {
      publicOrigin = value.trim() ? normalizePublicOrigin(value.trim()) : undefined
    } catch (err) {
      setOriginError(getErrorMessage(err, 'Enter an absolute HTTP or HTTPS website URL'))
      return
    }
    setOriginError(null)
    updateSiteSettings({ publicOrigin })
  }

  const { isTranslation } = useEditorLocale()
  if (isTranslation) return <SourceLocaleNotice />

  if (error) {
    return <p className={s.sectionDescription} role="alert">{error}</p>
  }

  if (!site) {
    return <SkeletonBlock minHeight={200} ariaLabel="Loading site settings" />
  }

  const frameworkPreferences = resolveFrameworkPreferences(site.settings.framework?.preferences)
  const treeShakeId = 'publishing-tree-shake-framework-utilities'

  return (
    <div>
      <p className={s.sectionDescription}>
        Published pages are served by this self-hosted CMS.
      </p>

      <div className={s.genFieldRow}>
        <label htmlFor="publishing-public-origin" className={s.label}>Public website URL</label>
        <Input id="publishing-public-origin" type="url" defaultValue={site.settings.publicOrigin ?? ''}
          placeholder="https://example.com"
          aria-invalid={originError ? true : undefined}
          aria-describedby={originError ? 'publishing-origin-error' : undefined}
          onBlur={(event) => savePublicOrigin(event.target.value)} />
        {originError && <p id="publishing-origin-error" role="alert" className={s.sectionDescription}>{originError}</p>}
        <p className={s.sectionDescription}>Used for canonical URLs, language alternates and the sitemap.</p>
      </div>

      <section aria-labelledby="pub-runtime-heading" className={s.sectionBlock}>
        <h4 id="pub-runtime-heading" className={s.subHeading}>
          Runtime
        </h4>

        <dl className={s.pubRuntimeList}>
          <div>
            <dt>Site</dt>
            <dd>/</dd>
          </div>
          <div>
            <dt>Admin</dt>
            <dd>/admin</dd>
          </div>
          <div>
            <dt>Draft source</dt>
            <dd>Database</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="pub-framework-heading" className={s.sectionBlock}>
        <h4 id="pub-framework-heading" className={s.subHeading}>
          Framework CSS
        </h4>

        <div className={s.cardGroup}>
          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor={treeShakeId} className={s.toggleRowLabel}>
                Tree-shake generated framework utilities
              </label>
              <p className={s.toggleRowDesc}>
                Emit only generated color, typography, and spacing utility classes used in the page
                and component trees. Turn this off when custom runtime code references generated
                utilities outside the editor tree.
              </p>
            </div>
            <Switch
              id={treeShakeId}
              checked={frameworkPreferences.treeShakeGeneratedFrameworkUtilities}
              onCheckedChange={(value) =>
                updateFrameworkPreferences({ treeShakeGeneratedFrameworkUtilities: value })
              }
            />
          </div>
        </div>
      </section>
    </div>
  )
}
