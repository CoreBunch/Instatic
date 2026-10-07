import { useId, useState } from 'react'
import type { SiteSettings } from '@core/page-tree'
import { LanguageCatalogueSchema, type TranslationMessages } from '@core/localization-schema'
import { canonicalLanguage, resolveSiteLanguage } from '@core/localization'
import { safeParseJson } from '@core/utils/jsonValidate'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { useAdminUi } from '@admin/state/adminUi'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import s from '../SettingsModal.module.css'

const EMPTY_CATALOGUES: Readonly<NonNullable<SiteSettings['localization']>['catalogues']> = []

function blankMessages(messages: TranslationMessages): TranslationMessages {
  return Object.fromEntries(Object.entries(messages).map(([key, value]) =>
    [key, typeof value === 'string' ? '' : blankMessages(value)],
  ))
}

/** Catalogue creation and editing use the same native file/collab lane as scripts. */
export function LanguageFilesField({ settings, onChange }: {
  settings: SiteSettings
  onChange: (patch: Partial<SiteSettings>) => void
}) {
  const site = useEditorStore((state) => state.site)
  const createFile = useEditorStore((state) => state.createFile)
  const openInEditor = useEditorStore((state) => state.openInEditor)
  const [newLanguage, setNewLanguage] = useState('')
  const languageInputId = useId()
  const catalogues = settings.localization?.catalogues ?? EMPTY_CATALOGUES
  let validation: string | null = null
  try {
    if (site) resolveSiteLanguage(site)
  } catch (error) {
    validation = getErrorMessage(error, 'Invalid language files')
  }

  function editFile(fileId: string) {
    openInEditor(fileId)
    useAdminUi.getState().closeSettings()
  }

  function addCatalogue() {
    if (!site) return
    try {
      const language = canonicalLanguage(newLanguage)
      if (catalogues.some((entry) => canonicalLanguage(entry.language) === language)) {
        throw new Error(`A language file already exists for ${language}`)
      }
      let messages: TranslationMessages = {}
      const firstFile = site.files.find((file) => file.id === catalogues[0]?.fileId)
      if (firstFile?.content) {
        const first = safeParseJson(firstFile.content, LanguageCatalogueSchema)
        if (!first.ok) throw first.error
        messages = blankMessages(first.value.messages)
      }
      const fileId = createFile(`locales/${language}.json`, 'config', JSON.stringify({ language, messages }, null, 2))
      onChange({
        localization: { catalogues: [...catalogues, { language, fileId }] },
        ...(catalogues.length === 0 ? { language } : {}),
      })
      setNewLanguage('')
      editFile(fileId)
    } catch (error) {
      console.error('[LanguageFilesField] create language file failed:', error)
      pushToast({ kind: 'error', title: 'Unable to create language file', body: getErrorMessage(error, 'Unknown language file error') })
    }
  }

  return (
    <div className={s.genFieldRow}>
      <span className={s.label}>Language files</span>
      <p className={s.sectionDescription}>
        Shared labels resolve from these files in the editor and published pages. Editorial page content stays in the CMS.
      </p>
      {catalogues.map((entry) => {
        const file = site?.files.find((candidate) => candidate.id === entry.fileId)
        return <div key={entry.language} className={s.faviconActions}>
          <span>{entry.language} · {file?.path ?? 'Language file'}</span>
          <Button variant="secondary" size="sm" disabled={!site || !file} onClick={() => editFile(entry.fileId)}>Edit translations</Button>
          <Button variant="ghost" size="sm" onClick={() => {
            const remaining = catalogues.filter((candidate) => candidate !== entry)
            onChange({ localization: remaining.length ? { catalogues: remaining } : undefined })
          }}>Remove language</Button>
        </div>
      })}
      {site ? <>
        <label htmlFor={languageInputId} className={s.label}>New language</label>
        <Input id={languageInputId} value={newLanguage} placeholder="en" spellCheck={false}
          onChange={(event) => setNewLanguage(event.target.value)} />
        <Button variant="secondary" size="sm" disabled={!newLanguage.trim()} onClick={addCatalogue}>Add language file</Button>
      </> : <p className={s.sectionDescription}>Open the Site workspace to create and edit language files.</p>}
      {validation && <p className={s.sectionDescription} role="alert">{validation}</p>}
    </div>
  )
}
