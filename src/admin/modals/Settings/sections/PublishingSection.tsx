/**
 * PublishingSection — self-hosted CMS publishing details.
 *
 * Also owns the published-page Content-Security-Policy allowlist
 * (`settings.csp`): the only place an owner can let a third-party script
 * origin (analytics, tag manager, ad pixel) through the publisher's
 * `script-src 'self'` default. Textareas commit on blur (one origin per line);
 * invalid lines are reported next to the field and never persisted.
 */
import { useState } from 'react'
import { useSiteSettingsController } from '../useSiteSettingsController'
import { resolveFrameworkPreferences } from '@core/framework'
import { isCspOrigin, parseCspOriginList, type SiteCspSettings } from '@core/page-tree'
import { Switch } from '@ui/components/Switch'
import { Textarea } from '@ui/components/Input'
import { SkeletonBlock } from '@ui/components/Skeleton'
import s from '../SettingsModal.module.css'

type CspListKey = keyof SiteCspSettings

const EMPTY_CSP: SiteCspSettings = { scriptOrigins: [], connectOrigins: [] }

/** Split a textarea into candidate origins: one per line, trimmed, blanks dropped. */
function splitOriginLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function PublishingSection() {
  const { site, error, updateFrameworkPreferences, updateSiteSettings } =
    useSiteSettingsController()
  const [cspErrors, setCspErrors] = useState<Partial<Record<CspListKey, string>>>({})

  if (error) {
    return <p className={s.sectionDescription} role="alert">{error}</p>
  }

  if (!site) {
    return <SkeletonBlock minHeight={200} ariaLabel="Loading site settings" />
  }

  const frameworkPreferences = resolveFrameworkPreferences(site.settings.framework?.preferences)
  const treeShakeId = 'publishing-tree-shake-framework-utilities'
  const csp = site.settings.csp ?? EMPTY_CSP

  function commitCspList(key: CspListKey, raw: string) {
    const lines = splitOriginLines(raw)
    const invalid = lines.filter((line) => !isCspOrigin(line))
    setCspErrors((prev) => ({
      ...prev,
      [key]: invalid.length > 0 ? `Not an https:// origin: ${invalid.join(', ')}` : undefined,
    }))
    const next: SiteCspSettings = { ...csp, [key]: parseCspOriginList(lines) }
    const isEmpty = next.scriptOrigins.length === 0 && next.connectOrigins.length === 0
    updateSiteSettings({ csp: isEmpty ? undefined : next })
  }

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
        </div>
      </section>

      <section aria-labelledby="pub-csp-heading" className={s.sectionBlock}>
        <h4 id="pub-csp-heading" className={s.subHeading}>
          Content Security Policy
        </h4>
        <p className={s.fieldHint}>
          Published pages only run scripts from this site. List the third-party origins your
          runtime scripts load from (analytics, tag managers, ad pixels) and the origins they
          send data to. One <code>https://</code> origin per line, for example{' '}
          <code>https://www.googletagmanager.com</code>. Wildcard subdomains such as{' '}
          <code>https://*.google-analytics.com</code> are allowed; paths and{' '}
          <code>http://</code> are not.
        </p>

        <div className={s.genFieldRow}>
          <label htmlFor="pub-csp-script-origins" className={s.label}>
            Allowed script origins
          </label>
          <Textarea
            id="pub-csp-script-origins"
            rows={3}
            spellCheck={false}
            defaultValue={csp.scriptOrigins.join('\n')}
            placeholder={'https://www.googletagmanager.com\nhttps://connect.facebook.net'}
            invalid={Boolean(cspErrors.scriptOrigins)}
            aria-describedby={cspErrors.scriptOrigins ? 'pub-csp-script-origins-error' : undefined}
            onBlur={(e) => commitCspList('scriptOrigins', e.target.value)}
          />
          {cspErrors.scriptOrigins && (
            <p id="pub-csp-script-origins-error" className={s.fieldError} role="alert">
              {cspErrors.scriptOrigins}
            </p>
          )}
        </div>

        <div className={s.genFieldRow}>
          <label htmlFor="pub-csp-connect-origins" className={s.label}>
            Allowed connection origins
          </label>
          <Textarea
            id="pub-csp-connect-origins"
            rows={3}
            spellCheck={false}
            defaultValue={csp.connectOrigins.join('\n')}
            placeholder={'https://www.google-analytics.com\nhttps://*.google-analytics.com'}
            invalid={Boolean(cspErrors.connectOrigins)}
            aria-describedby={cspErrors.connectOrigins ? 'pub-csp-connect-origins-error' : undefined}
            onBlur={(e) => commitCspList('connectOrigins', e.target.value)}
          />
          {cspErrors.connectOrigins && (
            <p id="pub-csp-connect-origins-error" className={s.fieldError} role="alert">
              {cspErrors.connectOrigins}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
