/**
 * PublishingSection — self-hosted CMS publishing details.
 */
import { useSiteSettingsController } from '../useSiteSettingsController'
import { resolveFrameworkPreferences } from '@core/framework'
import { Switch } from '@ui/components/Switch'
import { SkeletonBlock } from '@ui/components/Skeleton'
import s from '../SettingsModal.module.css'

export function PublishingSection() {
  const { site, error, updateFrameworkPreferences } = useSiteSettingsController()

  if (error) {
    return <p className={s.sectionDescription} role="alert">{error}</p>
  }

  if (!site) {
    return <SkeletonBlock minHeight={200} ariaLabel="Loading site settings" />
  }

  const frameworkPreferences = resolveFrameworkPreferences(site.settings.framework?.preferences)
  const treeShakeId = 'publishing-tree-shake-framework-utilities'
  const rootFontSizeId = 'publishing-emit-root-font-size'
  const { rootFontSize } = frameworkPreferences
  const rootFontSizePercent = Number(((rootFontSize / 16) * 100).toFixed(4))

  return (
    <div>
      <p className={s.sectionDescription}>
        Published pages are served by this self-hosted CMS.
      </p>

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
          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor={rootFontSizeId} className={s.toggleRowLabel}>
                Set the root font size
              </label>
              <p className={s.toggleRowDesc}>
                Sets <code>html {'{'} font-size: {rootFontSizePercent}% {'}'}</code> so 1rem is{' '}
                {rootFontSize}px and framework type and spacing render at the sizes the scale
                shows, in the editor and on the published site. Turning this on for an existing
                site makes every rem size smaller, so review your pages after switching.
              </p>
            </div>
            <Switch
              id={rootFontSizeId}
              checked={frameworkPreferences.emitRootFontSize}
              onCheckedChange={(value) => updateFrameworkPreferences({ emitRootFontSize: value })}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
