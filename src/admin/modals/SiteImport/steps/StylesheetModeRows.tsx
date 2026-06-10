/**
 * StylesheetModeRows — the per-stylesheet import-mode picker at the top of
 * the Review step's Style rules pane. One row per top-level linked sheet:
 * convert to editable style rules (default) or keep as a page-scoped
 * stylesheet file. Kept sheets get an include checkbox; converted sheets are
 * toggled through their rule groups below.
 */

import { Checkbox } from '@ui/components/Checkbox'
import { Select } from '@ui/components/Select'
import type { ImportPlan, StylesheetImportMode } from '@core/siteImport'
import styles from './AnalyzeStep.module.css'

interface StylesheetModeRowsProps {
  plan: ImportPlan
  /** Kept-stylesheet paths currently selected for import. */
  stylesheetsIncluded: ReadonlySet<string>
  busy: boolean
  onToggleStylesheet: (path: string) => void
  onStylesheetModeChange: (path: string, mode: StylesheetImportMode) => void
}

export function StylesheetModeRows({
  plan,
  stylesheetsIncluded,
  busy,
  onToggleStylesheet,
  onStylesheetModeChange,
}: StylesheetModeRowsProps) {
  if (plan.linkedStylesheets.length === 0) return null

  return (
    <div className={styles.rows}>
      {plan.linkedStylesheets.map((sheet) => {
        const kept = sheet.mode === 'file'
        const keptEntry = kept ? plan.stylesheets.find((s) => s.path === sheet.path) : undefined
        const on = !kept || stylesheetsIncluded.has(sheet.path)
        const pageCount = keptEntry?.pageSources.length ?? sheet.pageSources.length
        return (
          <div key={sheet.path} className={styles.pageRow} data-off={on ? undefined : 'true'}>
            {kept ? (
              <Checkbox
                checked={on}
                boxSize="sm"
                onCheckedChange={() => onToggleStylesheet(sheet.path)}
                aria-label={`Include stylesheet ${sheet.path}`}
              />
            ) : (
              <span className={styles.chip}>css</span>
            )}
            <div className={styles.info}>
              <span className={styles.title}>{sheet.path}</span>
              <span className={styles.meta}>
                {kept
                  ? `Imported as a stylesheet file, scoped to ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`
                  : `Converted to editable style rules · used by ${sheet.pageSources.length} ${sheet.pageSources.length === 1 ? 'page' : 'pages'}`}
              </span>
            </div>
            <Select
              value={sheet.mode}
              disabled={busy}
              aria-label={`Import mode for ${sheet.path}`}
              options={[
                { value: 'convert', label: 'Editable style rules' },
                { value: 'file', label: 'Keep as stylesheet' },
              ]}
              onChange={(e) =>
                onStylesheetModeChange(sheet.path, e.target.value === 'file' ? 'file' : 'convert')}
            />
          </div>
        )
      })}
    </div>
  )
}
