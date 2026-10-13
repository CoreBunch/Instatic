import { Switch } from '@ui/components/Switch'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { SiteVisitorPreferencesSchema, DEFAULT_SITE_VISITOR_PREFERENCES, type SiteVisitorPreferences, type VisitorPreferenceName } from '@core/visitor-preferences-schema'
import s from '../SettingsModal.module.css'

export function VisitorPreferencesFields({ value, onChange }: {
  value: SiteVisitorPreferences | undefined
  onChange: (value: SiteVisitorPreferences | undefined) => void
}) {
  function commit(name: VisitorPreferenceName, choice: string) {
    if (!value) return
    const next = { ...value, [name]: choice }
    if (!compiledCheck(SiteVisitorPreferencesSchema, next)) {
      pushToast({ kind: 'error', title: 'Invalid visitor preference', body: 'Choose one of the declared site defaults.' })
      return
    }
    onChange(next)
  }
  return <>
    <div className={s.genFieldRow}>
      <label htmlFor="site-visitor-preferences" className={s.label}>Visitor preferences</label>
      <Switch id="site-visitor-preferences" checked={value !== undefined} onCheckedChange={enabled => onChange(enabled ? { ...DEFAULT_SITE_VISITOR_PREFERENCES } : undefined)} />
      <p className={s.sectionDescription}>Declare site defaults before adding a visitor preference control or decorative video. Appearance uses the framework palettes. Reduced motion from the operating system is always respected.</p>
    </div>
    {value && <>
      <div className={s.genFieldRow}>
        <label htmlFor="site-visitor-theme" className={s.label}>Default appearance</label>
        <Select id="site-visitor-theme" value={value.theme} onChange={event => commit('theme', event.currentTarget.value)}>
          <option value="system">System preference</option><option value="default">Default palette</option><option value="alt">Alternate palette</option>
        </Select>
      </div>
      <div className={s.genFieldRow}>
        <label htmlFor="site-visitor-motion" className={s.label}>Default motion</label>
        <Select id="site-visitor-motion" value={value.motion} onChange={event => commit('motion', event.currentTarget.value)}>
          <option value="system">System preference</option><option value="reduced">Reduced motion</option>
        </Select>
      </div>
      <div className={s.genFieldRow}>
        <label htmlFor="site-visitor-media" className={s.label}>Default decorative media</label>
        <Select id="site-visitor-media" value={value.media} onChange={event => commit('media', event.currentTarget.value)}>
          <option value="full">Full media</option><option value="reduced">Reduced media</option>
        </Select>
      </div>
    </>}
  </>
}
