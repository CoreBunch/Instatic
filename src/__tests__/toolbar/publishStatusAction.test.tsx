/**
 * The toolbar's "N code errors" status is actionable: one click opens the
 * first error's file in the Code Editor, whose Problems list names every
 * error with its file:line:column. Before, the chip was a passive label and
 * the Problems list only rendered once a script file was open — a user who
 * did not know that had no path from the error count to the error.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StepUpProvider } from '@admin/shared/StepUp'
import { PublishButton } from '@admin/pages/site/toolbar/PublishButton'
import { useEditorStore } from '@site/store/store'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'
import '@modules/base/index'

afterEach(() => {
  cleanup()
  useEditorStore.getState().closeEditor()
  useEditorStore.getState().clearSite()
})

const unresolved: SiteRuntimeDiagnostic = {
  code: 'runtime-bundle-error',
  severity: 'error',
  message: 'Could not resolve "canvas-confetti"',
  fileId: 'main-js',
  path: 'src/scripts/main.js',
  line: 2,
  column: 21,
}

function mount(diagnostics: SiteRuntimeDiagnostic[]) {
  useEditorStore.getState().createSite('Toolbar')
  return render(
    <StepUpProvider>
      <PublishButton enabled runtimeDiagnostics={diagnostics} />
    </StepUpProvider>,
  )
}

describe('PublishButton code-error status', () => {
  it('is a button that opens the first error\'s file in the Code Editor', () => {
    mount([unresolved])
    const chip = screen.getByTestId('toolbar-status-action')
    expect(chip.textContent).toContain('1 code error')
    expect(chip.getAttribute('aria-label')).toContain('src/scripts/main.js')
    expect(useEditorStore.getState().codeEditorPanelOpen).toBe(false)

    fireEvent.click(chip)

    expect(useEditorStore.getState().activeEditorFileId).toBe('main-js')
    expect(useEditorStore.getState().codeEditorPanelOpen).toBe(true)
  })

  it('stays a passive status when no error names a file', () => {
    mount([{ ...unresolved, fileId: undefined, path: undefined, line: undefined, column: undefined }])
    expect(screen.queryByTestId('toolbar-status-action')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('1 code error')
  })
})
