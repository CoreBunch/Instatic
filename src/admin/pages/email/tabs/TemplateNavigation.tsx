import { useState } from 'react'
import type { MailTemplate } from '@core/mail'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { Select } from '@ui/components/Select'
import { SettingsListSection } from '@admin/shared/SettingsWorkspace/SettingsListSection'
import styles from '../EmailPage.module.css'

function templateStatus(template: MailTemplate): string {
  if (!template.sendingEnabled) return 'Sending off'
  if (!template.customised) return ''
  return template.wordingProblem ? 'Not used' : 'Edited'
}

export function TemplateNavigation({ templates, selectedKey, onSelect }: {
  templates: MailTemplate[]
  selectedKey: string
  onSelect: (key: string) => void
}) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const groups = [...new Set(templates.map((template) => template.group))].map((label) => ({
    label,
    items: templates.filter((template) => template.group === label),
  }))
  const visibleGroups = groups.map(({ label, items }) => ({
    label,
    items: items.filter((template) => `${label} ${template.label}`.toLowerCase().includes(query)),
  })).filter(({ items }) => items.length > 0)

  return (
    <>
      <aside className={styles.templateSidebar} aria-label="Available templates">
        <SearchBar value={search} onValueChange={setSearch} placeholder="Search templates" aria-label="Search templates" />
        {visibleGroups.map(({ label, items }) => (
          <SettingsListSection key={label} label={label}>
            {items.map((template) => {
              const active = template.key === selectedKey
              const status = templateStatus(template)
              return (
                <Button key={template.key} variant={active ? 'secondary' : 'ghost'} size="sm" align="start" fullWidth active={active}
                  aria-current={active ? 'true' : undefined} className={styles.templateRow}
                  onClick={() => onSelect(template.key)}>
                  <span>{template.label}</span>
                  {status && <small>{status}</small>}
                </Button>
              )
            })}
          </SettingsListSection>
        ))}
        {visibleGroups.length === 0 && <p className={styles.hint} role="status">No matching templates.</p>}
      </aside>
      <div className={styles.templatePicker}>
        <Select aria-label="Choose template" value={selectedKey} onChange={(event) => onSelect(event.currentTarget.value)}>
          {groups.map(({ label, items }) => (
            <optgroup key={label} label={label}>
              {items.map((template) => {
                const status = templateStatus(template)
                return <option key={template.key} value={template.key}>{template.label}{status && ` · ${status}`}</option>
              })}
            </optgroup>
          ))}
        </Select>
      </div>
    </>
  )
}
