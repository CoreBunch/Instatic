/**
 * SiteStylesheetRows — the stylesheets no imported page links, in the Review
 * step's Style rules pane. Each one imports as a site-wide stylesheet file
 * (it has no page cascade to convert into), so the row says where it lands
 * and one switch leaves it out.
 */

import { Switch } from '@ui/components/Switch'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import type { ImportPlan } from '@core/siteImport'
import { isSiteWideStylesheet } from '../shared/importPlanning'
import styles from './AnalyzeStep.module.css'

interface SiteStylesheetRowsProps {
  plan: ImportPlan
  /** Stylesheet-file paths currently selected for import. */
  stylesheetsIncluded: ReadonlySet<string>
  onToggleStylesheet: (path: string) => void
}

export function SiteStylesheetRows({ plan, stylesheetsIncluded, onToggleStylesheet }: SiteStylesheetRowsProps) {
  const sheets = plan.stylesheets.filter(isSiteWideStylesheet)
  if (sheets.length === 0) return null
  const hasPages = plan.pages.length > 0

  return (
    <section className={styles.modeRows} aria-label="Site stylesheets">
      <p className={styles.rowsLabel}>
        {hasPages ? 'Site stylesheets · not linked by any imported page' : 'Site stylesheets'}
      </p>
      {sheets.map((sheet) => {
        const on = stylesheetsIncluded.has(sheet.path)
        return (
          <div key={sheet.path} className={styles.listRow} data-off={on ? undefined : 'true'}>
            <span className={styles.listIcon}>
              <FileTextSolidIcon size={14} />
            </span>
            <div className={styles.info}>
              <span className={styles.title}>{sheet.path}</span>
              <span className={styles.meta}>
                {on
                  ? 'Added to the Code panel as a site stylesheet, applied to every page'
                  : 'Left out of this import'}
              </span>
            </div>
            <Switch
              checked={on}
              switchSize="sm"
              onCheckedChange={() => onToggleStylesheet(sheet.path)}
              aria-label={`Import stylesheet ${sheet.path}`}
            />
          </div>
        )
      })}
    </section>
  )
}
