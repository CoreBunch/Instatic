/**
 * InsertFragmentModal — Spotlight "Insert fragment from file…".
 *
 * Pick a fragment package (`.zip`) or a media-free `fragment.json`; the
 * dialog plans the insert against the open document and shows what it will
 * add and what it keeps from this site; "Insert" runs the server work and the
 * single store transaction, then shows what was added. Nothing changes until
 * "Insert"; one undo removes the whole insert afterwards.
 *
 * Mounted lazily by AdminCanvasEditorBody while `insertFragmentModalOpen`.
 */

import { useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { FileUpload } from '@ui/components/FileUpload'
import { pushToast } from '@ui/components/Toast'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import type { FragmentInsertPlan, FragmentInsertResult } from '@core/fragments'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { FragmentReport } from './FragmentReport'
import { loadFragmentFile, planLoadedFragment, runFragmentInsert, type LoadedFragment } from './fragmentInsertFlow'
import styles from './InsertFragmentModal.module.css'

type Step =
  | { kind: 'pick' }
  | { kind: 'reading'; fileName: string }
  | { kind: 'review'; loaded: LoadedFragment; plan: FragmentInsertPlan }
  | { kind: 'running'; loaded: LoadedFragment; plan: FragmentInsertPlan; line: string }
  | { kind: 'done'; loaded: LoadedFragment; result: FragmentInsertResult }

type SetStep = (next: Step | ((current: Step) => Step)) => void

// Module-level so the React Compiler can compile the component body
// (try/catch in an async function inside it would bail out).
async function readAndPlan(file: File, setStep: SetStep): Promise<void> {
  setStep({ kind: 'reading', fileName: file.name })
  try {
    const loaded = await loadFragmentFile(file)
    const plan = await planLoadedFragment(loaded)
    setStep({ kind: 'review', loaded, plan })
  } catch (err) {
    console.error('[InsertFragmentModal] reading the fragment failed:', err)
    pushToast({ kind: 'error', title: 'Could not insert this fragment', body: getErrorMessage(err, 'Unknown fragment error') })
    setStep({ kind: 'pick' })
  }
}

async function insert(
  loaded: LoadedFragment,
  plan: FragmentInsertPlan,
  controller: AbortController,
  setStep: SetStep,
): Promise<void> {
  setStep({ kind: 'running', loaded, plan, line: 'Starting' })
  try {
    const result = await runFragmentInsert(loaded, plan, controller.signal, (line) =>
      setStep((current) => (current.kind === 'running' ? { ...current, line } : current)),
    )
    setStep({ kind: 'done', loaded, result })
    pushToast({
      kind: result.report.warnings.length > 0 ? 'warning' : 'success',
      title: result.pageId ? 'Page added' : 'Fragment inserted',
      body: result.report.warnings.length > 0
        ? `${result.report.warnings.length} note${result.report.warnings.length === 1 ? '' : 's'} in the report.`
        : 'One undo removes it.',
      location: 'site-editor',
    })
  } catch (err) {
    if (isAbortError(err)) {
      pushToast({ kind: 'info', title: 'Insert cancelled', body: 'Files already uploaded stay in the media library.' })
    } else {
      console.error('[InsertFragmentModal] insert failed:', err)
      pushToast({ kind: 'error', title: 'Insert failed', body: getErrorMessage(err, 'Unknown insert error') })
    }
    setStep({ kind: 'review', loaded, plan })
  }
}

function titleFor(step: Step): string {
  if (step.kind === 'done') return step.result.pageId ? 'Page added' : 'Fragment inserted'
  return 'Insert fragment'
}

export function InsertFragmentModal() {
  const closeModal = useEditorStore((s) => s.closeInsertFragmentModal)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const controller = useRef<AbortController | null>(null)

  function handleClose() {
    if (step.kind === 'running') {
      controller.current?.abort()
      return
    }
    closeModal()
  }

  function handlePick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void readAndPlan(file, setStep)
  }

  function handleInsert() {
    if (step.kind !== 'review') return
    controller.current = new AbortController()
    void insert(step.loaded, step.plan, controller.current, setStep)
  }

  function handleOpenPage(pageId: string) {
    openPageInCanvas(pageId)
    closeModal()
  }

  const picker = (
    <FileUpload
      accept=".zip,.json,application/zip,application/json"
      onChange={handlePick}
      buttonProps={{ variant: 'secondary', size: 'sm', 'aria-label': 'Choose a fragment file', disabled: step.kind === 'reading' }}
    >
      <UploadIcon size={13} />
      <span>{step.kind === 'review' ? 'Choose a different file' : 'Choose fragment…'}</span>
    </FileUpload>
  )

  return (
    <Dialog
      open={true}
      onClose={handleClose}
      title={titleFor(step)}
      eyebrow="Fragments"
      size="lg"
      footer={(
        <>
          {step.kind === 'done' && step.result.pageId && (
            <Button variant="secondary" onClick={() => handleOpenPage(step.result.pageId!)}>Open page</Button>
          )}
          <Button variant="ghost" onClick={handleClose}>
            {step.kind === 'running' ? 'Cancel insert' : step.kind === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {step.kind !== 'done' && (
            <Button
              variant="primary"
              onClick={handleInsert}
              disabled={step.kind !== 'review'}
              data-testid="insert-fragment-confirm"
            >
              {step.kind === 'running' ? 'Inserting…' : 'Insert'}
            </Button>
          )}
        </>
      )}
    >
      {step.kind === 'pick' && (
        <div className={styles.pick}>
          <p className={styles.body}>
            Insert a section, page or component exported as a fragment. It lands where a pasted
            layer would, and brings the classes, colours, fonts, components, tables and media it
            needs. Anything this site already has stays as it is.
          </p>
          {picker}
        </div>
      )}

      {step.kind === 'reading' && (
        <p className={styles.body} role="status">Reading {step.fileName}…</p>
      )}

      {(step.kind === 'review' || step.kind === 'running') && (
        <div className={styles.review}>
          <div className={styles.fileRow}>
            <p className={styles.fileName}>
              <strong>{step.loaded.fileName}</strong>
              {' '}
              <span className={styles.meta}>
                {step.plan.kind === 'page' ? 'page' : step.plan.kind === 'component' ? 'component' : 'section'}
                {step.loaded.fragment.origin?.item ? ` · ${step.loaded.fragment.origin.item}` : ''}
              </span>
            </p>
            {step.kind === 'review' && picker}
          </div>
          {step.kind === 'running' && <p className={styles.progress} role="status">{step.line}</p>}
          <FragmentReport report={step.plan.report} done={false} />
        </div>
      )}

      {step.kind === 'done' && <FragmentReport report={step.result.report} done={true} />}
    </Dialog>
  )
}
