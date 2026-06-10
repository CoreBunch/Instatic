/**
 * SiteImportModal — the Super Import wizard.
 *
 * A canonical import dialog for both static-site imports and CMS-native site
 * bundles. Static-site inputs (folder, .zip, loose files) import into the
 * visual editor in one undo-able operation. CMS-exported JSON bundles use the
 * server-side transfer endpoints for full import/export parity.
 *
 * Steps:
 *   drop      → user drops/picks files
 *   analyze    → review static plan: pages, style rules, media, skipped items
 *   cms-review → review CMS bundle diff + merge strategy
 *   conflicts  → resolve slug / class-name conflicts (skipped if none)
 *   run        → upload assets + commit static plan to store
 *
 * Mount pattern: the authenticated admin shell renders
 * `{siteImportOpen && <SiteImportModal />}` so the component is always freshly
 * mounted on open — no reset logic needed.
 *
 * Undo guarantee: `mutateAllPagesAndSite` wraps the full commit in one Immer
 * history snapshot, so Cmd+Z reverts the entire import in one press.
 */

// Static-site analysis maps HTML onto base modules (`importHtml` resolves
// every element through the module registry). The modal is a global surface —
// openable from Spotlight or any workspace — so it must register the base
// modules itself rather than rely on the site editor's chunk having loaded.
// This rides the modal's own lazy chunk; it adds nothing to the shell bundle.
import '@modules/base'
import { useState, type ReactNode } from 'react'
import { nanoid } from 'nanoid'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import {
  ingestInput,
  buildImportPlan,
  commitImportPlan,
  type FileMap,
  type ImportPlan,
  type ImportResult,
  type ConflictResolution,
  type StylesheetImportMode,
} from '@core/siteImport'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { DropStep } from './steps/DropStep'
import { AnalyzeStep } from './steps/AnalyzeStep'
import { ConflictsStep } from './steps/ConflictsStep'
import { ImportStep } from './steps/ImportStep'
import { CmsBundleReviewStep } from './steps/CmsBundleReviewStep'
import { makeInitialRunProgress, type RunProgress } from './shared/importProgress'
import { createSiteImportAdapter } from './shared/createSiteImportAdapter'
import { describeCmsBundleLoadError, useCmsBundleImport } from './shared/useCmsBundleImport'
import {
  type ImportSelection,
  tokenConflictKey,
  crossSheetConflictKey,
  makeDefaultSelection,
  filterPlanBySelection,
  buildResolvedPlan,
  describeIngestError,
  ensureCurrentSiteForStaticImport,
  saveImportedDraftSite,
} from './shared/importPlanning'
import styles from './SiteImportModal.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Step = 'drop' | 'analyze' | 'conflicts' | 'run' | 'cms-review'

export type { ImportSelection }

interface SiteImportModalProps {
  onCmsBundleImportComplete?: () => void
}

// ---------------------------------------------------------------------------
// Modal component
// ---------------------------------------------------------------------------

export function SiteImportModal({ onCmsBundleImportComplete }: SiteImportModalProps = {}) {
  const closeAdminSiteImportModal = useAdminUi((s) => s.closeSiteImport)
  function closeModal() {
    closeAdminSiteImportModal()
  }

  const {
    cmsBundleState,
    cmsCanImport,
    cmsImportButtonLabel,
    clearCmsBundle,
    importCmsBundle,
    loadCmsBundleFile,
    setCmsStrategy,
  } = useCmsBundleImport({
    closeModal,
    onImportComplete: onCmsBundleImportComplete,
  })

  // ── Wizard state ──────────────────────────────────────────────────────────

  const [step, setStep] = useState<Step>('drop')
  const [fileMap, setFileMap] = useState<FileMap | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [selection, setSelection] = useState<ImportSelection | null>(null)
  const [pageResolutions, setPageResolutions] = useState<Map<string, ConflictResolution>>(new Map())
  const [ruleResolutions, setRuleResolutions] = useState<Map<string, ConflictResolution>>(new Map())
  const [tokenResolutions, setTokenResolutions] = useState<Map<string, ConflictResolution>>(new Map())
  const [crossSheetResolutions, setCrossSheetResolutions] = useState<Map<string, ConflictResolution>>(new Map())
  const [stylesheetModes, setStylesheetModes] = useState<Record<string, StylesheetImportMode>>({})
  const [pageSlugOverrides, setPageSlugOverrides] = useState<Map<string, string>>(new Map())
  const [runProgress, setRunProgress] = useState<RunProgress>(makeInitialRunProgress)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [logOpen, setLogOpen] = useState(false)

  const siteName = useEditorStore((s) => s.site?.name) ?? 'this site'

  // ── Ingest + plan-build (triggered from DropStep callbacks) ───────────────

  async function handleFilesReady(files: File[]) {
    setBusy(true)
    setErrorMsg(null)
    try {
      if (files.length === 1 && await loadCmsBundleFile(files[0])) {
        setFileMap(null)
        setPlan(null)
        setSelection(null)
        setBusy(false)
        setStep('cms-review')
        return
      }

      const map = await ingestInput(files)
      await finalizePlan(map)
    } catch (err) {
      console.error('[SiteImportModal] ingest failed:', err)
      const singleJson = files.length === 1 && files[0].name.toLowerCase().endsWith('.json')
      setErrorMsg(singleJson ? describeCmsBundleLoadError(err) : describeIngestError(err))
      setBusy(false)
    }
  }

  async function handleZipReady(zipBytes: Uint8Array) {
    setBusy(true)
    setErrorMsg(null)
    try {
      const map = await ingestInput({ zipBytes })
      await finalizePlan(map)
    } catch (err) {
      console.error('[SiteImportModal] ingest failed:', err)
      setErrorMsg(describeIngestError(err))
      setBusy(false)
    }
  }

  // Merge additional dropped/picked files into the existing FileMap and rebuild
  // the plan. The Review step accepts more files at any time (drag-over overlay
  // + "Add more files" button), so the import isn't one-shot.
  async function handleAddFiles(files: File[]) {
    if (!fileMap) {
      await handleFilesReady(files)
      return
    }
    setBusy(true)
    try {
      const added = await ingestInput(files)
      const merged: FileMap = {
        ...fileMap,
        files: { ...fileMap.files, ...added.files },
      }
      await finalizePlan(merged)
    } catch (err) {
      console.error('[SiteImportModal] add files failed:', err)
      setBusy(false)
      pushToast({ kind: 'error', title: 'Could not add files', body: describeIngestError(err) })
    }
  }

  async function finalizePlan(map: FileMap, modes: Record<string, StylesheetImportMode> = stylesheetModes) {
    const currentSite = await ensureCurrentSiteForStaticImport()
    const importPlan = buildImportPlan({
      fileMap: map,
      currentSite,
      options: { mediaTolerance: 10, stylesheetModes: modes },
    })
    setFileMap(map)
    setPlan(importPlan)
    setSelection(makeDefaultSelection(importPlan))
    setPageResolutions(
      new Map(importPlan.conflicts.pages.map((c) => [c.source, c.defaultResolution])),
    )
    setRuleResolutions(
      new Map(importPlan.conflicts.rules.map((c) => [c.desiredName, c.defaultResolution])),
    )
    setTokenResolutions(
      new Map(importPlan.conflicts.tokens.map((c) => [tokenConflictKey(c), c.defaultResolution])),
    )
    setCrossSheetResolutions(
      new Map(importPlan.conflicts.crossSheetClasses.map((c) => [crossSheetConflictKey(c), c.defaultResolution])),
    )
    setPageSlugOverrides(new Map())
    setBusy(false)
    setStep('analyze')
  }

  // Re-analyse with a changed per-stylesheet import mode. The plan rebuild is
  // synchronous and pure, so flipping a sheet between "editable rules" and
  // "keep as stylesheet" instantly refreshes rules, conflicts, and selection.
  function handleStylesheetModeChange(path: string, mode: StylesheetImportMode) {
    if (!fileMap) return
    const modes = { ...stylesheetModes, [path]: mode }
    setStylesheetModes(modes)
    setBusy(true)
    void finalizePlan(fileMap, modes)
  }

  // ── Step navigation ───────────────────────────────────────────────────────

  function handleAnalyzeNext() {
    if (!plan || !selection) return

    // Apply user slug overrides to the plan's pages
    const planWithSlugs: ImportPlan = {
      ...plan,
      pages: plan.pages.map((p) => ({
        ...p,
        slug: pageSlugOverrides.get(p.source) ?? p.slug,
      })),
    }

    const filtered = filterPlanBySelection(planWithSlugs, selection)
    const hasConflicts =
      filtered.conflicts.pages.length > 0 ||
      filtered.conflicts.rules.length > 0 ||
      filtered.conflicts.tokens.length > 0 ||
      filtered.conflicts.crossSheetClasses.length > 0

    if (hasConflicts) {
      setPlan(filtered)
      setStep('conflicts')
    } else {
      setPlan(filtered)
      void kickOffRun(filtered, pageResolutions, ruleResolutions, tokenResolutions)
    }
  }

  function handleConflictsImport() {
    if (!plan) return
    void kickOffRun(plan, pageResolutions, ruleResolutions, tokenResolutions)
  }

  function handleCmsChooseDifferentFile() {
    clearCmsBundle()
    setErrorMsg(null)
    setBusy(false)
    setStep('drop')
  }

  function handleBack() {
    if (step === 'conflicts') setStep('analyze')
    else if (step === 'analyze') setStep('drop')
    else if (step === 'cms-review') handleCmsChooseDifferentFile()
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  async function kickOffRun(
    planToRun: ImportPlan,
    pageResMap: Map<string, ConflictResolution>,
    ruleResMap: Map<string, ConflictResolution>,
    tokenResMap: Map<string, ConflictResolution>,
  ) {
    const resolvedPlan = buildResolvedPlan(planToRun, pageResMap, ruleResMap, tokenResMap, crossSheetResolutions)

    // Totals come from the plan being committed. Media is the only genuinely
    // incremental phase (per-asset uploads); everything else lands in one atomic
    // commit, so those rows flip pending → done together once it completes.
    const initial = makeInitialRunProgress()
    initial.phase = 'uploading'
    initial.categories = {
      pages: { done: 0, total: resolvedPlan.pages.length },
      // Kept stylesheet files count alongside converted rules — one "styles" row.
      styles: { done: 0, total: resolvedPlan.styleRules.length + resolvedPlan.stylesheets.length },
      media: { done: 0, total: resolvedPlan.assets.length },
      colors: { done: 0, total: resolvedPlan.colors.length },
      fonts: {
        done: 0,
        total: resolvedPlan.fonts.length + resolvedPlan.googleFonts.length + resolvedPlan.fontTokens.length,
      },
      scripts: { done: 0, total: resolvedPlan.scripts.length },
    }
    setLogOpen(false)
    setResult(null)
    setRunProgress(initial)
    setStep('run')

    const adapter = createSiteImportAdapter({
      sessionId: nanoid(),
      onUploadStart: ({ path }) => {
        setRunProgress((prev) => ({ ...prev, phase: 'uploading', currentItem: path }))
      },
      onUploadComplete: ({ path }) => {
        setRunProgress((prev) => ({
          ...prev,
          currentItem: path,
          categories: {
            ...prev.categories,
            media: { ...prev.categories.media, done: prev.categories.media.done + 1 },
          },
        }))
      },
      onCommitStart: () => {
        setRunProgress((prev) => ({
          ...prev,
          phase: 'applying',
          currentItem: 'Applying changes to your site…',
        }))
      },
      onCommitComplete: () => {
        setRunProgress((prev) => ({ ...prev, phase: 'applying' }))
      },
    })

    try {
      const importResult = await commitImportPlan(resolvedPlan, adapter)
      setRunProgress((prev) => ({
        ...prev,
        phase: 'applying',
        currentItem: 'Saving imported draft…',
      }))
      await saveImportedDraftSite()
      // Reconcile every category to what was actually committed — skipped pages
      // or rules (conflict resolutions) leave fewer than the planned totals.
      setRunProgress((prev) => ({
        ...prev,
        phase: 'done',
        currentItem: '',
        categories: {
          pages: { done: importResult.pages.length, total: importResult.pages.length },
          styles: {
            done: importResult.styleRules.length + importResult.stylesheets.length,
            total: importResult.styleRules.length + importResult.stylesheets.length,
          },
          media: { done: importResult.assets.length, total: importResult.assets.length },
          colors: { done: importResult.colors.length, total: importResult.colors.length },
          fonts: {
            done: importResult.fonts.length + importResult.fontTokens.length,
            total: importResult.fonts.length + importResult.fontTokens.length,
          },
          scripts: { done: importResult.scripts.length, total: importResult.scripts.length },
        },
      }))
      setResult(importResult)
      pushToast({
        kind: 'success',
        title: 'Site imported',
        body: `${importResult.pages.length} pages · ${importResult.styleRules.length} style rules · ${importResult.assets.length} assets`,
        location: 'site-workspace',
      })
    } catch (err) {
      console.error('[SiteImportModal] commit failed:', err)
      const msg = getErrorMessage(err, 'Unknown import error')
      setRunProgress((prev) => ({ ...prev, phase: 'failed', currentItem: '', errorMessage: msg }))
      pushToast({ kind: 'error', title: 'Import failed', body: msg })
    }
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  function handleClose() {
    if (runProgress.phase === 'applying') return // uncancellable during commit
    if (cmsBundleState?.importing) return
    closeModal()
  }

  function handleRunCancel() {
    // During upload phase we can close (orphaned assets are harmless per spec).
    closeModal()
  }

  // Open the freshly-imported site: jump to the first imported page in the
  // canvas, then close the wizard. Falls back to a plain close when nothing
  // imported (e.g. a styles-only import).
  function handleOpenSite() {
    const firstPage = result?.pages[0]
    if (firstPage) useEditorStore.getState().openPageInCanvas(firstPage.id)
    closeModal()
  }

  // ── Footer ────────────────────────────────────────────────────────────────

  function renderFooter(): ReactNode {
    if (step === 'drop') return null

    if (step === 'analyze') {
      const pageCount = selection ? selection.pagesIncluded.size : 0
      const ruleCount = selection ? selection.styleRulesIncluded.size : 0
      const mediaCount = selection ? selection.assetsIncluded.size : 0
      return (
        <>
          <span className={styles.footNote}>
            {pageCount} {pageCount === 1 ? 'page' : 'pages'} · {ruleCount} rules · {mediaCount} media selected
          </span>
          <Button variant="secondary" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={pageCount === 0}
            onClick={handleAnalyzeNext}
          >
            Continue →
          </Button>
        </>
      )
    }

    if (step === 'conflicts') {
      return (
        <>
          <Button variant="secondary" type="button" onClick={handleBack}>
            ← Back
          </Button>
          <Button variant="primary" type="button" onClick={handleConflictsImport}>
            Import
          </Button>
        </>
      )
    }

    if (step === 'cms-review') {
      return (
        <>
          <span className={styles.footNote}>
            CMS bundle import preserves exported tables, rows, site shell, and media.
          </span>
          <Button
            variant="secondary"
            type="button"
            disabled={cmsBundleState?.importing}
            onClick={handleBack}
          >
            Back
          </Button>
          <Button
            variant={cmsBundleState?.strategy === 'replace' ? 'destructive' : 'primary'}
            type="button"
            disabled={!cmsCanImport}
            onClick={() => { void importCmsBundle() }}
          >
            {cmsImportButtonLabel}
          </Button>
        </>
      )
    }

    if (step === 'run') {
      const phase = runProgress.phase

      if (phase === 'done') {
        return (
          <>
            <span className={styles.footNote}>
              <strong>{siteName}</strong> is ready
            </span>
            <Button variant="ghost" type="button" onClick={() => setLogOpen((o) => !o)}>
              {logOpen ? 'Hide import log' : 'View import log'}
            </Button>
            <Button variant="primary" type="button" onClick={handleOpenSite}>
              Open site →
            </Button>
          </>
        )
      }

      if (phase === 'failed') {
        return (
          <>
            <span className={styles.footNote}>Import didn’t finish</span>
            <Button variant="secondary" type="button" onClick={handleClose}>
              Close
            </Button>
          </>
        )
      }

      // Running (idle / uploading / applying).
      const canCancel = phase === 'uploading' || phase === 'idle'
      return (
        <>
          <span className={styles.footNote}>Keep this window open while importing…</span>
          <Button
            variant="secondary"
            type="button"
            disabled={!canCancel}
            onClick={handleRunCancel}
          >
            Cancel
          </Button>
        </>
      )
    }

    return null
  }

  // ── Step titles ───────────────────────────────────────────────────────────

  const titleByStep: Record<Step, string> = {
    drop: 'Import site',
    analyze: 'Review import',
    'cms-review': 'Review bundle',
    conflicts: 'Resolve conflicts',
    // The Import step title tracks its phase: "Importing" while running,
    // "Import complete" once committed.
    run: runProgress.phase === 'done' ? 'Import complete' : 'Importing',
  }
  const isCmsReplace = step === 'cms-review' && cmsBundleState?.strategy === 'replace'
  const isCmsImporting = step === 'cms-review' && cmsBundleState?.importing === true

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog
      open={true}
      onClose={handleClose}
      title={titleByStep[step]}
      eyebrow="Instatic"
      size={step === 'analyze' ? '2xl' : 'xl'}
      tone={isCmsReplace ? 'danger' : 'neutral'}
      footer={renderFooter() ?? undefined}
      bodyClassName={
        step === 'analyze' || step === 'cms-review'
          ? styles.analyzeBody
          : step === 'run'
            ? styles.importBody
            : undefined
      }
      closeOnEscape={runProgress.phase !== 'applying' && !isCmsImporting}
      closeOnBackdrop={runProgress.phase !== 'applying' && !isCmsImporting}
    >
      <div className={styles.body}>
        {step === 'drop' && (
          <DropStep
            busy={busy}
            errorMessage={errorMsg}
            onFilesReady={(files) => { void handleFilesReady(files) }}
            onZipReady={(bytes) => { void handleZipReady(bytes) }}
          />
        )}

        {step === 'analyze' && plan && fileMap && selection && (
          <AnalyzeStep
            plan={plan}
            siteName={siteName}
            selection={selection}
            pageSlugOverrides={pageSlugOverrides}
            busy={busy}
            onSelectionChange={setSelection}
            onStylesheetModeChange={handleStylesheetModeChange}
            onAddFiles={(files) => { void handleAddFiles(files) }}
            onSlugOverride={(source, slug) => {
              setPageSlugOverrides((prev) => {
                const next = new Map(prev)
                next.set(source, slug)
                return next
              })
            }}
          />
        )}

        {step === 'conflicts' && plan && (
          <ConflictsStep
            plan={plan}
            pageResolutions={pageResolutions}
            ruleResolutions={ruleResolutions}
            tokenResolutions={tokenResolutions}
            onPageResolutionChange={(source, resolution) => {
              setPageResolutions((prev) => {
                const next = new Map(prev)
                next.set(source, resolution)
                return next
              })
            }}
            onRuleResolutionChange={(desiredName, resolution) => {
              setRuleResolutions((prev) => {
                const next = new Map(prev)
                next.set(desiredName, resolution)
                return next
              })
            }}
            onTokenResolutionChange={(key, resolution) => {
              setTokenResolutions((prev) => {
                const next = new Map(prev)
                next.set(key, resolution)
                return next
              })
            }}
            crossSheetResolutions={crossSheetResolutions}
            onCrossSheetResolutionChange={(key, resolution) => {
              setCrossSheetResolutions((prev) => {
                const next = new Map(prev)
                next.set(key, resolution)
                return next
              })
            }}
          />
        )}

        {step === 'cms-review' && cmsBundleState && (
          <CmsBundleReviewStep
            filename={cmsBundleState.filename}
            preview={cmsBundleState.preview}
            previewLoading={cmsBundleState.previewLoading}
            previewError={cmsBundleState.previewError}
            strategy={cmsBundleState.strategy}
            onStrategyChange={setCmsStrategy}
            onChooseDifferentFile={handleCmsChooseDifferentFile}
          />
        )}

        {step === 'run' && (
          <ImportStep
            progress={runProgress}
            siteName={siteName}
            result={result}
            droppedAtRules={plan?.droppedAtRules.length ?? 0}
            logOpen={logOpen}
          />
        )}
      </div>
    </Dialog>
  )
}
