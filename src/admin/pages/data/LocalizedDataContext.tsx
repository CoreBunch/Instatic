import type { ReactNode } from 'react'
import type { DataTable } from '@core/data/schemas'
import { Select } from '@ui/components/Select'
import { Button } from '@ui/components/Button'
import { LocalizedDataContext, useLocalizedData, useLocalizedDataResource } from './localizedData'
import styles from './LocalizedDataContext.module.css'

export function ContentLanguageSelect() {
  const state = useLocalizedData()
  if (!state?.required) return null
  return <div className={styles.languageControl}>
    <Select aria-label="Content language" value={state.language} placeholder="Choose content language"
      options={(state.data?.languages ?? []).map(language => ({ value: language, label: language }))}
      onChange={event => state.setLanguage(event.target.value)} />
    {state.error && <Button variant="ghost" size="sm" onClick={state.refresh}>Retry language data</Button>}
  </div>
}

/** Reused by standalone Content field editors, with the same explicit language control. */
export function LocalizedDataProvider({ tables, revision, children }: { tables: readonly DataTable[]; revision: unknown; children: ReactNode }) {
  const state = useLocalizedDataResource(tables, revision)
  return <LocalizedDataContext.Provider value={state}><ContentLanguageSelect />{children}</LocalizedDataContext.Provider>
}
