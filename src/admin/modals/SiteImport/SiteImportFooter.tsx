import { Button } from '@ui/components/Button'
import type { ImportResult as CmsImportResult } from '@core/data/bundleSchema'
import type { ImportPlan } from '@core/siteImport'
import { selectedImportCount, type ImportSelection } from './shared/importPlanning'
import type { RunProgress } from './shared/importProgress'
import type { CmsBundleState } from './shared/useCmsBundleImport'
import {
  selectedCmsMediaCount,
  selectedCmsRowCount,
} from './shared/cmsBundleFlow'
import styles from './SiteImportModal.module.css'

type Step = 'drop' | 'analyze' | 'conflicts' | 'run'

interface SiteImportFooterProps {
  step: Step
  cmsBundleState: CmsBundleState | null
  plan: ImportPlan | null
  selection: ImportSelection | null
  runProgress: RunProgress
  cmsResult: CmsImportResult | null
  logOpen: boolean
  siteName: string
  cmsCanImport: boolean
  cmsImportButtonLabel: string
  onBack: () => void
  onClose: () => void
  onAnalyzeNext: () => void
  onCmsAnalyzeNext: () => void
  onConflictsImport: () => void
  onRunCancel: () => void
  onToggleLog: () => void
  onOpenSite: () => void
}

export function SiteImportFooter({
  step,
  cmsBundleState,
  plan,
  selection,
  runProgress,
  cmsResult,
  logOpen,
  siteName,
  cmsCanImport,
  cmsImportButtonLabel,
  onBack,
  onClose,
  onAnalyzeNext,
  onCmsAnalyzeNext,
  onConflictsImport,
  onRunCancel,
  onToggleLog,
  onOpenSite,
}: SiteImportFooterProps) {
  if (step === 'drop') return null

  if (step === 'analyze') {
    if (cmsBundleState) {
      const rowCount = selectedCmsRowCount(cmsBundleState.selection, cmsBundleState.bundle)
      const mediaCount = selectedCmsMediaCount(cmsBundleState.selection, cmsBundleState.bundle.media?.length ?? 0)
      return (
        <>
          <span className={styles.footNote}>
            {rowCount} {rowCount === 1 ? 'row' : 'rows'} · {mediaCount} media selected
          </span>
          <Button
            variant="secondary"
            type="button"
            disabled={cmsBundleState.importing}
            onClick={onBack}
          >
            Back
          </Button>
          <Button
            variant={cmsBundleState.strategy === 'replace' ? 'destructive' : 'primary'}
            type="button"
            disabled={!cmsCanImport}
            onClick={onCmsAnalyzeNext}
          >
            {cmsImportButtonLabel}
          </Button>
        </>
      )
    }

    const pageCount = selection ? selection.pagesIncluded.size : 0
    const ruleCount = selection ? selection.styleRulesIncluded.size : 0
    const mediaCount = selection ? selection.assetsIncluded.size : 0
    const sheetCount = selection ? selection.stylesheetsIncluded.size : 0
    // An import needs no page: stylesheets, rules, media or fonts alone are valid.
    const nothingSelected = !plan || !selection || selectedImportCount(plan, selection) === 0
    return (
      <>
        <span className={styles.footNote}>
          {nothingSelected
            ? 'Nothing is selected to import'
            : <>
                {pageCount} {pageCount === 1 ? 'page' : 'pages'} · {ruleCount} rules
                {sheetCount > 0 && ` · ${sheetCount} ${sheetCount === 1 ? 'stylesheet' : 'stylesheets'}`}
                {' '}· {mediaCount} media selected
              </>}
        </span>
        <Button variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="button"
          disabled={nothingSelected}
          onClick={onAnalyzeNext}
        >
          Continue →
        </Button>
      </>
    )
  }

  if (step === 'conflicts') {
    return (
      <>
        <Button variant="secondary" type="button" onClick={onBack}>
          ← Back
        </Button>
        <Button variant="primary" type="button" onClick={onConflictsImport}>
          Import
        </Button>
      </>
    )
  }

  if (step === 'run') {
    const phase = runProgress.phase

    if (phase === 'done') {
      const cmsDone = cmsResult !== null
      return (
        <>
          <span className={styles.footNote}>
            <strong>{siteName}</strong> is ready
          </span>
          {!cmsDone && (
            <Button variant="ghost" type="button" onClick={onToggleLog}>
              {logOpen ? 'Hide import log' : 'View import log'}
            </Button>
          )}
          <Button variant="primary" type="button" onClick={onOpenSite}>
            {cmsDone ? 'Close' : 'Open site →'}
          </Button>
        </>
      )
    }

    if (phase === 'failed') {
      return (
        <>
          <span className={styles.footNote}>Import didn’t finish</span>
          <Button variant="secondary" type="button" onClick={onClose}>
            Close
          </Button>
        </>
      )
    }

    const canCancel = phase === 'uploading' || phase === 'idle'
    return (
      <>
        <span className={styles.footNote}>Keep this window open while importing…</span>
        <Button
          variant="secondary"
          type="button"
          disabled={!canCancel}
          onClick={onRunCancel}
        >
          Cancel
        </Button>
      </>
    )
  }

  return null
}
