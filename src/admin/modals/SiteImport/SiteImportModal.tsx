/**
 * SiteImportModal — the Super Import wizard.
 *
 * A canonical import dialog for both static-site imports and CMS-native site
 * bundles. Static-site inputs (folder, .zip, loose files) import into the
 * visual editor in one undo-able operation. CMS-exported ZIP bundles use the
 * server-side transfer endpoints for full import/export parity.
 *
 * Steps:
 *   drop      → user drops/picks files
 *   analyze    → review static plan or CMS bundle categories
 *   conflicts  → resolve slug / class-name conflicts (skipped if none)
 *   run        → upload assets + commit static plan to store
 *
 * Mount pattern: the authenticated admin shell renders
 * `{siteImportOpen && <SiteImportModal />}` so the component is always freshly
 * mounted on open — no reset logic needed.
 *
 * Undo guarantee: `mutateAllPagesAndSite` wraps the full commit in one Mutative
 * history snapshot, so Cmd+Z reverts the entire import in one press.
 */

// Static-site analysis maps HTML onto base modules (`importHtml` resolves
// every element through the module registry). The modal is a global surface —
// openable from Spotlight or any workspace — so it must register the base
// modules itself rather than rely on the site editor's chunk having loaded.
// This rides the modal's own lazy chunk; it adds nothing to the shell bundle.
import '@modules/base'
import { useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { isAbortError } from '@core/http'
import { Dialog } from '@ui/components/Dialog'
import { pushToast } from '@ui/components/Toast'
import {
  ingestInput,
  buildImportPlan,
  commitImportPlan,
  detectPluginPackage,
  withPageSlugs,
  type FileMap,
  type ImportPlan,
  type ImportResult,
  type ConflictResolution,
  type StylesheetImportMode,
} from '@core/siteImport'
import { useAdminUi } from '@admin/state/adminUi'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { canAccessWorkspace, canInstallPlugins, workspacePath } from '@admin/access'
import { useEditorStore } from '@site/store/store'
import { DropStep, type DroppedPluginPackage } from './steps/DropStep'
import { AnalyzeStep } from './steps/AnalyzeStep'
import { CmsBundleAnalyzeStep } from './steps/CmsBundleAnalyzeStep'
import { CmsBundleConflictsStep } from './steps/CmsBundleConflictsStep'
import { ConflictsStep } from './steps/ConflictsStep'
import { ImportStep } from './steps/ImportStep'
import { SiteImportFooter } from './SiteImportFooter'
import {
  describeStaticImportResult,
  importNeedsAttention,
  makeCmsRunDoneProgress,
  makeCmsRunProgress,
  makeInitialRunProgress,
  makeStaticRunDoneProgress,
  makeStaticRunProgress,
  type CmsRunTotals,
  type RunProgress,
} from './shared/importProgress'
import { createSiteImportAdapter } from './shared/createSiteImportAdapter'
import { describeCmsBundleLoadError, useCmsBundleImport } from './shared/useCmsBundleImport'
import {
  selectedCmsConflicts,
  selectedCmsMediaCount,
  selectedCmsMediaFolderCount,
  selectedCmsRedirectCount,
  selectedCmsRowCount,
  withCmsConflictResolutions,
} from './shared/cmsBundleFlow'
import {
  type ImportSelection,
  type ConflictResolutionMaps,
  defaultConflictResolutions,
  emptyConflictResolutionMaps,
  classRenameProblems,
  siteClassNameSet,
  makeDefaultSelection,
  filterPlanBySelection,
  buildResolvedPlan,
  describeIngestError,
  ensureCurrentSiteForStaticImport,
  saveImportedDraftSite,
  withMediaAlreadyInLibrary,
} from './shared/importPlanning'
import styles from './SiteImportModal.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'
import type {
  BundleImportSelection,
  ImportResult as CmsImportResult,
} from '@core/data/bundleSchema'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Step = 'drop' | 'analyze' | 'conflicts' | 'run'

export type { ImportSelection }

interface SiteImportModalProps {
  onCmsBundleImportComplete?: () => void
}

// ---------------------------------------------------------------------------
// Modal component
// ---------------------------------------------------------------------------

export function SiteImportModal({ onCmsBundleImportComplete }: SiteImportModalProps = {}) {
  const navigate = useAdminNavigate()
  const closeModal = useAdminUi((s) => s.closeSiteImport)

  const {
    cmsBundleState,
    cmsCanImport,
    cmsImportButtonLabel,
    clearCmsBundle,
    importCmsBundle,
    loadCmsBundleArchiveFile,
    loadCmsBundleFile,
    setCmsSelection,
    setCmsStrategy,
  } = useCmsBundleImport({
    onImportComplete: onCmsBundleImportComplete,
  })

  // ── Wizard state ──────────────────────────────────────────────────────────

  const [step, setStep] = useState<Step>('drop')
  const [fileMap, setFileMap] = useState<FileMap | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [selection, setSelection] = useState<ImportSelection | null>(null)
  // The user's choice per static-import conflict, one map per category.
  const [resolutions, setResolutions] = useState<ConflictResolutionMaps>(emptyConflictResolutionMaps)
  const [siteClassNames, setSiteClassNames] = useState<ReadonlySet<string>>(new Set())
  const [cmsRowResolutions, setCmsRowResolutions] = useState<Map<string, ConflictResolution>>(new Map())
  // Per-sheet import modes. Only plan builds read them, and a build must use
  // the latest modes whenever it starts, so they live in a ref, not state.
  const stylesheetModesRef = useRef<Record<string, StylesheetImportMode>>({})
  const [pageSlugOverrides, setPageSlugOverrides] = useState<Map<string, string>>(new Map())
  const [runProgress, setRunProgress] = useState<RunProgress>(makeInitialRunProgress)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [cmsResult, setCmsResult] = useState<CmsImportResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [pluginPackage, setPluginPackage] = useState<DroppedPluginPackage | null>(null)
  const [busy, setBusy] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  // Cancellation handle for the active static run. Aborting stops queued and
  // in-flight uploads and prevents the store commit and draft save.
  const runAbortRef = useRef<AbortController | null>(null)
  // The plan build in flight. Files dropped onto Review rebuild the plan while
  // an earlier build may still wait on its media lookup; only the latest one
  // may land, so a newer build aborts the older one.
  const planBuildRef = useRef<AbortController | null>(null)
  // The file map the newest plan build is for. `fileMap` state only changes
  // once a build lands, so files dropped while a build runs merge into this.
  const latestFileMapRef = useRef<FileMap | null>(null)
  // The file map of the plan on screen, for when a newer build fails.
  const shownFileMapRef = useRef<FileMap | null>(null)

  const siteName = useEditorStore((s) => s.site?.name) ?? 'this site'
  const currentUser = useCurrentAdminUser()
  const canInstallPluginPackage =
    canAccessWorkspace(currentUser, 'plugins') && canInstallPlugins(currentUser)

  // A plugin package is not a site: stop at the Drop step and point at the
  // Plugins page instead of importing its frontend files as loose assets.
  function stopAtPluginPackage(map: FileMap, fileName: string | null): boolean {
    const detected = detectPluginPackage(map)
    if (!detected) return false
    setPluginPackage({ fileName, name: detected.name })
    setBusy(false)
    return true
  }

  function handleOpenPlugins() {
    navigate(workspacePath('plugins'))
    closeModal()
  }

  // ── Ingest + plan-build (triggered from DropStep callbacks) ───────────────

  function reviewCmsBundle() {
    planBuildRef.current?.abort()
    latestFileMapRef.current = null
    shownFileMapRef.current = null
    setFileMap(null)
    setPlan(null)
    setSelection(null)
    setCmsRowResolutions(new Map())
    setCmsResult(null)
    setBusy(false)
    setStep('analyze')
  }

  async function handleFilesReady(files: File[]) {
    setBusy(true)
    setErrorMsg(null)
    setPluginPackage(null)
    try {
      if (files.length === 1 && await loadCmsBundleFile(files[0])) {
        reviewCmsBundle()
        return
      }

      const map = await ingestInput(files)
      if (stopAtPluginPackage(map, null)) return
      await finalizePlan(map)
    } catch (err) {
      console.error('[SiteImportModal] ingest failed:', err)
      const singleJson = files.length === 1 && files[0].name.toLowerCase().endsWith('.json')
      setErrorMsg(singleJson ? describeCmsBundleLoadError(err) : describeIngestError(err))
      setBusy(false)
    }
  }

  async function handleZipReady(file: File) {
    setBusy(true)
    setErrorMsg(null)
    setPluginPackage(null)
    try {
      if (await loadCmsBundleArchiveFile(file)) {
        reviewCmsBundle()
        return
      }

      const zipBytes = new Uint8Array(await file.arrayBuffer())
      const map = await ingestInput({ zipBytes })
      if (stopAtPluginPackage(map, file.name)) return
      await finalizePlan(map)
    } catch (err) {
      console.error('[SiteImportModal] ingest failed:', err)
      setErrorMsg(err instanceof Error && err.name === 'SiteBundleParseError'
        ? describeCmsBundleLoadError(err)
        : describeIngestError(err))
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
      // Read after the await: another drop may have started a newer build.
      const base = latestFileMapRef.current ?? shownFileMapRef.current ?? fileMap
      const merged: FileMap = {
        ...base,
        files: { ...base.files, ...added.files },
      }
      await finalizePlan(merged)
    } catch (err) {
      console.error('[SiteImportModal] add files failed:', err)
      setBusy(false)
      pushToast({ kind: 'error', title: 'Could not add files', body: describeIngestError(err) })
    }
  }

  async function finalizePlan(map: FileMap) {
    planBuildRef.current?.abort()
    latestFileMapRef.current = map
    const build = new AbortController()
    planBuildRef.current = build
    let importPlan: ImportPlan
    try {
      const currentSite = await ensureCurrentSiteForStaticImport()
      if (build.signal.aborted) return
      importPlan = await withMediaAlreadyInLibrary(buildImportPlan({
        fileMap: map,
        currentSite,
        options: { mediaTolerance: 10, stylesheetModes: stylesheetModesRef.current },
      }), build.signal)
      if (!build.signal.aborted) setSiteClassNames(siteClassNameSet(currentSite))
    } catch (err) {
      // A failed build must not leave its files as the base for the next drop.
      if (build.signal.aborted) return
      latestFileMapRef.current = shownFileMapRef.current
      planBuildRef.current = null
      throw err
    }
    if (build.signal.aborted) return
    planBuildRef.current = null
    shownFileMapRef.current = map
    setFileMap(map)
    setPlan(importPlan)
    setSelection(makeDefaultSelection(importPlan))
    setResolutions(defaultConflictResolutions(importPlan))
    setPageSlugOverrides(new Map())
    setBusy(false)
    setStep('analyze')
  }

  // Re-analyse with a changed per-stylesheet import mode. The plan rebuild is
  // synchronous and pure, so flipping a sheet between "editable rules" and
  // "keep as stylesheet" instantly refreshes rules, conflicts, and selection.
  function handleStylesheetModeChange(path: string, mode: StylesheetImportMode) {
    const map = latestFileMapRef.current ?? fileMap
    if (!map) return
    stylesheetModesRef.current = { ...stylesheetModesRef.current, [path]: mode }
    setBusy(true)
    finalizePlan(map).catch((err: unknown) => {
      console.error('[SiteImportModal] stylesheet mode change failed:', err)
      setBusy(false)
      pushToast({ kind: 'error', title: 'Could not re-analyse the import', body: getErrorMessage(err, 'Unknown import error') })
    })
  }

  // ── Step navigation ───────────────────────────────────────────────────────

  function handleAnalyzeNext() {
    // The plan was built against this site (`finalizePlan` loaded it).
    const currentSite = useEditorStore.getState().site
    if (!plan || !selection || !currentSite) return

    // Page conflicts are checked again against the final slugs: the selected
    // pages only, with the slugs typed in the Review step.
    const filtered = withPageSlugs(filterPlanBySelection(plan, selection), currentSite, pageSlugOverrides)
    // A page whose conflict is unchanged keeps the choice already made for it.
    const nextPageResolutions = new Map(
      filtered.conflicts.pages.map((c) => {
        const previous = plan.conflicts.pages.find((p) => p.source === c.source && p.desiredSlug === c.desiredSlug)
        const chosen = previous ? resolutions.pages.get(c.source) : undefined
        return [c.source, chosen ?? c.defaultResolution]
      }),
    )
    const nextResolutions = { ...resolutions, pages: nextPageResolutions }
    setResolutions(nextResolutions)
    const hasConflicts =
      filtered.conflicts.pages.length > 0 ||
      filtered.conflicts.rules.length > 0 ||
      filtered.conflicts.tokens.length > 0 ||
      filtered.conflicts.crossSheetClasses.length > 0 ||
      filtered.conflicts.files.length > 0 ||
      filtered.conflicts.media.length > 0

    setPlan(filtered)
    if (hasConflicts) {
      setStep('conflicts')
    } else {
      void kickOffRun(filtered, nextResolutions)
    }
  }

  function handleCmsAnalyzeNext() {
    if (!cmsBundleState?.preview) return
    const conflicts = cmsBundleState.strategy === 'replace'
      ? []
      : selectedCmsConflicts(
          cmsBundleState.selection,
          cmsBundleState.bundle,
          cmsBundleState.preview.rowConflicts ?? [],
        )

    if (conflicts.length > 0) {
      setStep('conflicts')
      return
    }

    void kickOffCmsRun(cmsBundleState.selection)
  }

  function handleConflictsImport() {
    if (cmsBundleState?.preview) {
      const finalSelection = withCmsConflictResolutions(
        cmsBundleState.selection,
        cmsBundleState.bundle,
        cmsBundleState.preview.rowConflicts ?? [],
        cmsRowResolutions,
      )
      setCmsSelection(finalSelection)
      void kickOffCmsRun(finalSelection)
      return
    }
    if (!plan) return
    void kickOffRun(plan, resolutions)
  }

  function handleCmsChooseDifferentFile() {
    clearCmsBundle()
    setCmsRowResolutions(new Map())
    setCmsResult(null)
    setErrorMsg(null)
    setBusy(false)
    setStep('drop')
  }

  function handleBack() {
    if (step === 'conflicts') setStep('analyze')
    else if (step === 'analyze' && cmsBundleState) handleCmsChooseDifferentFile()
    else if (step === 'analyze') setStep('drop')
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  async function kickOffRun(planToRun: ImportPlan, resolutionMaps: ConflictResolutionMaps) {
    const resolvedPlan = buildResolvedPlan(planToRun, resolutionMaps)

    setLogOpen(false)
    setResult(null)
    setRunProgress(makeStaticRunProgress(resolvedPlan))
    setStep('run')

    const abortController = new AbortController()
    runAbortRef.current = abortController

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
      const importResult = await commitImportPlan(resolvedPlan, adapter, {
        signal: abortController.signal,
      })
      setRunProgress((prev) => ({
        ...prev,
        phase: 'applying',
        currentItem: 'Saving imported draft…',
      }))
      await saveImportedDraftSite()
      const doneProgress = makeStaticRunDoneProgress(resolvedPlan, importResult)
      setRunProgress(doneProgress)
      setResult(importResult)
      // A run that lost uploads or references is not a clean success: say so,
      // and open the log so the affected paths are on screen without a click.
      const needsAttention = importNeedsAttention(doneProgress, importResult)
      setLogOpen(needsAttention)
      const media = doneProgress.categories.media
      const mediaSummary = media.done < media.total
        ? `${media.done} of ${media.total} assets uploaded`
        : `${media.done} assets`
      pushToast({
        kind: needsAttention ? 'warning' : 'success',
        title: needsAttention ? 'Site imported with warnings' : 'Site imported',
        body: describeStaticImportResult(importResult, mediaSummary),
        location: 'site-workspace',
      })
    } catch (err) {
      // A cancelled run already closed the modal and toasted from
      // handleRunCancel — it is not a failure.
      if (isAbortError(err)) return
      console.error('[SiteImportModal] commit failed:', err)
      const msg = getErrorMessage(err, 'Unknown import error')
      setRunProgress((prev) => ({ ...prev, phase: 'failed', currentItem: '', errorMessage: msg }))
      pushToast({ kind: 'error', title: 'Import failed', body: msg })
    } finally {
      if (runAbortRef.current === abortController) runAbortRef.current = null
    }
  }

  async function kickOffCmsRun(selectionToImport: BundleImportSelection) {
    if (!cmsBundleState) return

    const totals: CmsRunTotals = {
      site: selectionToImport.includeSite && cmsBundleState.bundle.site ? 1 : 0,
      rows: selectedCmsRowCount(selectionToImport, cmsBundleState.bundle),
      media: selectedCmsMediaCount(selectionToImport, cmsBundleState.bundle.media?.length ?? 0),
      mediaFolders: selectedCmsMediaFolderCount(selectionToImport, cmsBundleState.bundle),
      redirects: selectedCmsRedirectCount(selectionToImport, cmsBundleState.bundle),
    }

    setLogOpen(false)
    setResult(null)
    setCmsResult(null)
    setRunProgress(makeCmsRunProgress(totals))
    setStep('run')

    try {
      const importResult = await importCmsBundle(selectionToImport)
      if (!importResult) {
        setStep('analyze')
        return
      }
      setRunProgress(makeCmsRunDoneProgress(totals, importResult))
      setCmsResult(importResult)
    } catch (err) {
      const msg = getErrorMessage(err, 'Unknown import error')
      setRunProgress((prev) => ({ ...prev, phase: 'failed', currentItem: '', errorMessage: msg }))
    }
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  function handleClose() {
    if (runProgress.phase === 'applying') return // uncancellable during commit
    if (cmsBundleState?.importing) return
    if (step === 'run' && runProgress.phase === 'uploading') {
      // Closing mid-upload (X, Escape, backdrop) is a cancel, not a detach —
      // otherwise the run keeps uploading and commits after the UI is gone.
      handleRunCancel()
      return
    }
    closeModal()
  }

  function handleRunCancel() {
    // Only the upload phase is cancellable — the store commit is one atomic
    // mutation, so the footer disables Cancel once 'applying' starts.
    runAbortRef.current?.abort()
    runAbortRef.current = null
    const uploaded = runProgress.categories.media.done
    pushToast({
      kind: 'info',
      title: 'Import cancelled',
      body: uploaded > 0
        ? `Nothing was imported. ${uploaded} ${uploaded === 1 ? 'file' : 'files'} already uploaded ${uploaded === 1 ? 'stays' : 'stay'} in the Media Library.`
        : 'Nothing was imported.',
    })
    closeModal()
  }

  // Open the freshly-imported site: jump to the first imported page in the
  // canvas, then close the wizard. An import with no pages (stylesheets only)
  // opens the Site workspace, where its files sit in the Code panel.
  function handleOpenSite() {
    const firstPage = result?.pages[0]
    if (firstPage) {
      useEditorStore.getState().openPageInCanvas(firstPage.id)
      navigate('/admin/site?table=pages&row=' + encodeURIComponent(firstPage.id))
    } else {
      navigate(workspacePath('site'))
    }
    closeModal()
  }

  // ── Step titles ───────────────────────────────────────────────────────────

  const titleByStep: Record<Step, string> = {
    drop: 'Import site',
    analyze: 'Review import',
    conflicts: 'Resolve conflicts',
    // The Import step title tracks its phase: "Importing" while running,
    // "Import complete" once committed.
    run: runProgress.phase === 'done' ? 'Import complete' : 'Importing',
  }
  const isCmsReplace = step === 'analyze' && cmsBundleState?.strategy === 'replace'
  const isCmsImporting = step === 'analyze' && cmsBundleState?.importing === true

  // ── Render ────────────────────────────────────────────────────────────────
  const classNameProblems = step === 'conflicts' && plan && !cmsBundleState
    ? classRenameProblems(plan, siteClassNames, resolutions.rules, resolutions.crossSheetClasses) : new Map<string, string>()

  return (
    <Dialog
      open={true}
      onClose={handleClose}
      title={titleByStep[step]}
      eyebrow="Instatic"
      size={step === 'analyze' ? '2xl' : 'xl'}
      tone={isCmsReplace ? 'danger' : 'neutral'}
      footer={step === 'drop' ? undefined : (
        <SiteImportFooter
          step={step}
          cmsBundleState={cmsBundleState}
          plan={plan}
          selection={selection}
          runProgress={runProgress}
          cmsResult={cmsResult}
          logOpen={logOpen}
          siteName={siteName}
          cmsCanImport={cmsCanImport}
          cmsImportButtonLabel={cmsImportButtonLabel}
          onBack={handleBack}
          onClose={handleClose}
          onAnalyzeNext={handleAnalyzeNext}
          onCmsAnalyzeNext={handleCmsAnalyzeNext}
          onConflictsImport={handleConflictsImport}
          classNameProblemCount={classNameProblems.size}
          onRunCancel={handleRunCancel}
          onToggleLog={() => setLogOpen((o) => !o)}
          onOpenSite={handleOpenSite}
        />
      )}
      bodyClassName={step === 'analyze' ? styles.analyzeBody : step === 'run' ? styles.importBody : undefined}
      closeOnEscape={runProgress.phase !== 'applying' && !isCmsImporting}
      closeOnBackdrop={runProgress.phase !== 'applying' && !isCmsImporting}
    >
      <div className={styles.body}>
        {step === 'drop' && (
          <DropStep
            busy={busy}
            errorMessage={errorMsg}
            pluginPackage={pluginPackage}
            canInstallPlugins={canInstallPluginPackage}
            onOpenPlugins={handleOpenPlugins}
            onFilesReady={(files) => { void handleFilesReady(files) }}
            onZipReady={(file) => { void handleZipReady(file) }}
          />
        )}

        {step === 'analyze' && cmsBundleState && (
          <CmsBundleAnalyzeStep
            state={cmsBundleState}
            siteName={siteName}
            onSelectionChange={setCmsSelection}
            onStrategyChange={setCmsStrategy}
            onChooseDifferentFile={handleCmsChooseDifferentFile}
          />
        )}

        {step === 'analyze' && !cmsBundleState && plan && fileMap && selection && (
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

        {step === 'conflicts' && cmsBundleState?.preview && (
          <CmsBundleConflictsStep
            conflicts={selectedCmsConflicts(
              cmsBundleState.selection,
              cmsBundleState.bundle,
              cmsBundleState.preview.rowConflicts ?? [],
            )}
            resolutions={cmsRowResolutions}
            onResolutionChange={(key, resolution) => {
              setCmsRowResolutions((prev) => {
                const next = new Map(prev)
                next.set(key, resolution)
                return next
              })
            }}
          />
        )}

        {step === 'conflicts' && !cmsBundleState && plan && (
          <ConflictsStep
            plan={plan}
            resolutions={resolutions}
            onResolutionChange={(category, key, resolution) => {
              setResolutions((prev) => ({ ...prev, [category]: new Map(prev[category]).set(key, resolution) }))
            }}
            classNameProblems={classNameProblems}
          />
        )}

        {step === 'run' && (
          <ImportStep
            progress={runProgress}
            siteName={siteName}
            result={result}
            cmsResult={cmsResult}
            droppedAtRules={plan?.droppedAtRules.length ?? 0}
            logOpen={logOpen}
            mode={cmsBundleState ? 'cms' : 'static'}
          />
        )}
      </div>
    </Dialog>
  )
}
