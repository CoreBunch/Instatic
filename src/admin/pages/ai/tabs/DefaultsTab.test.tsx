import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mocks — API
// ---------------------------------------------------------------------------

let mockListCredentials: Mock<() => Promise<unknown>>
let mockListDefaults: Mock<() => Promise<unknown>>
let mockSetDefault: Mock<(scope: string, body: { credentialId: string; modelId: string }) => Promise<void>>
let mockClearDefault: Mock<(scope: string) => Promise<void>>

const CRED_ANTHROPIC = {
  id: 'cred-a',
  providerId: 'anthropic',
  authMode: 'apiKey',
  displayLabel: 'Anthropic key',
  baseUrl: null,
  keyFingerprintCurrent: true,
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: null,
}

function resetApiMocks(defaults: Record<string, { credentialId: string; modelId: string }> = {}) {
  mockListCredentials = mock(async () => [CRED_ANTHROPIC])
  mockListDefaults = mock(async () => defaults)
  mockSetDefault = mock(async () => {})
  mockClearDefault = mock(async () => {})
}

// Initialize mocks before mock.module so the delegate wrappers have targets.
resetApiMocks()

mock.module('../../../ai/api', () => ({
  listCredentials: (...args: unknown[]) => mockListCredentials(...(args as [])),
  listDefaults: (...args: unknown[]) => mockListDefaults(...(args as [])),
  setDefault: (...a: unknown[]) => mockSetDefault(...(a as [string, { credentialId: string; modelId: string }])),
  clearDefault: (...a: unknown[]) => mockClearDefault(...(a as [string])),
}))

// ---------------------------------------------------------------------------
// Mocks — ModelPicker
//
// The actual ModelPicker opens a ContextMenu with lazy-loaded model lists,
// which is heavy to drive in unit tests and already tested in isolation.
// This stub renders a <select> that fires onChange with the chosen pair.
// ---------------------------------------------------------------------------

mock.module('@admin/ai/ModelPicker', () => ({
  ModelPicker: ({ value, onChange, ariaLabel, disabled }: {
    value: { credentialId: string; modelId: string } | null
    onChange: (choice: { credentialId: string; modelId: string }) => void
    ariaLabel?: string
    disabled?: boolean
  }) => (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      value={value ? `${value.credentialId}::${value.modelId}` : ''}
      onChange={(e) => {
        const [credentialId, modelId] = e.target.value.split('::')
        onChange({ credentialId: credentialId!, modelId: modelId! })
      }}
    >
      <option value="">Choose credential and model</option>
      <option value="cred-a::claude-opus">claude-opus</option>
      <option value="cred-a::claude-sonnet">claude-sonnet</option>
      <option value="cred-a::claude-haiku">claude-haiku</option>
    </select>
  ),
}))

// ---------------------------------------------------------------------------
// Mocks — Toast
// ---------------------------------------------------------------------------

mock.module('@ui/components/Toast', () => ({
  pushToast: (input: { kind: string; title: string; body?: string }) => {
    const toast = document.createElement('div')
    toast.dataset.testToast = 'true'
    toast.setAttribute('role', 'alert')
    toast.textContent = [input.title, input.body].filter(Boolean).join(' ')
    document.body.append(toast)
    return 'toast-id'
  },
}))

// ---------------------------------------------------------------------------
// Dynamic import (after all mocks are registered)
// ---------------------------------------------------------------------------

const { DefaultsTab } = await import('./DefaultsTab')

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-test-toast]').forEach((toast) => toast.remove())
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderTab() {
  return render(<DefaultsTab onNavigateToProviders={() => {}} />)
}

/** Select a model from the stub ModelPicker for the given scope label. */
function pickModel(scopeLabel: string, model: string) {
  const picker = screen.getByLabelText(`Model for ${scopeLabel}`)
  fireEvent.change(picker, { target: { value: `cred-a::${model}` } })
}

/** Click a scope button in the sidebar to switch tabs. */
function selectScope(label: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }))
}

/** Find the Save button (starts with "Save" to avoid matching "unsaved" in sidebar). */
function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^sav/i }) as HTMLButtonElement
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultsTab – batch save', () => {
  beforeEach(() => resetApiMocks())

  it('saves defaults for multiple scopes in a single click', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    // Pick model for Site
    pickModel('Site editor', 'claude-opus')

    // Switch to Content, pick model
    selectScope('Content')
    await waitFor(() => expect(screen.getByLabelText('Model for Content')).toBeTruthy())
    pickModel('Content', 'claude-sonnet')

    selectScope('Data')
    await waitFor(() => expect(screen.getByLabelText('Model for Data')).toBeTruthy())
    pickModel('Data', 'claude-haiku')

    selectScope('Plugins')
    await waitFor(() => expect(screen.getByLabelText('Model for Plugins')).toBeTruthy())
    pickModel('Plugins', 'claude-opus')

    expect(saveButton().textContent).toContain('Save 4 defaults')

    // Click Save once
    await act(async () => { fireEvent.click(saveButton()) })

    // All four scopes were submitted
    expect(mockSetDefault).toHaveBeenCalledTimes(4)
    const calls = mockSetDefault.mock.calls.map(([scope, body]) => ({ scope, ...body }))
    expect(calls).toContainEqual({ scope: 'site', credentialId: 'cred-a', modelId: 'claude-opus' })
    expect(calls).toContainEqual({ scope: 'content', credentialId: 'cred-a', modelId: 'claude-sonnet' })
    expect(calls).toContainEqual({ scope: 'data', credentialId: 'cred-a', modelId: 'claude-haiku' })
    expect(calls).toContainEqual({ scope: 'plugin', credentialId: 'cred-a', modelId: 'claude-opus' })
    expect(screen.getByRole('alert').textContent).toContain('Defaults saved')
    expect(saveButton().disabled).toBe(true)
  })

  it('preserves pending selections when switching between scopes', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    // Pick a model for Site
    pickModel('Site editor', 'claude-opus')

    // Switch away
    selectScope('Data')
    await waitFor(() => expect(screen.getByLabelText('Model for Data')).toBeTruthy())

    // Switch back — the picker should still show the pending value
    selectScope('Site editor')
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    const picker = screen.getByLabelText('Model for Site editor') as HTMLSelectElement
    expect(picker.value).toBe('cred-a::claude-opus')
  })

  it('does not submit unchanged scopes', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    // Only change Site
    pickModel('Site editor', 'claude-opus')

    await act(async () => { fireEvent.click(saveButton()) })

    expect(mockSetDefault).toHaveBeenCalledTimes(1)
    expect(mockSetDefault.mock.calls[0]![0]).toBe('site')
  })

  it('saves a single modified scope correctly', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    selectScope('Plugins')
    await waitFor(() => expect(screen.getByLabelText('Model for Plugins')).toBeTruthy())
    pickModel('Plugins', 'claude-haiku')

    await act(async () => { fireEvent.click(saveButton()) })

    expect(mockSetDefault).toHaveBeenCalledTimes(1)
    expect(mockSetDefault.mock.calls[0]).toEqual(['plugin', { credentialId: 'cred-a', modelId: 'claude-haiku' }])
  })

  it('disables the Save button when nothing has changed', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    expect(saveButton().disabled).toBe(true)
  })

  it('does not mark a persisted selection as changed', async () => {
    resetApiMocks({ site: { credentialId: 'cred-a', modelId: 'claude-opus' } })
    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    pickModel('Site editor', 'claude-opus')

    expect(saveButton().disabled).toBe(true)
    expect(screen.queryByLabelText('unsaved changes')).toBeNull()
  })

  it('prevents duplicate saves while saving is in progress', async () => {
    let resolveFirst!: () => void
    mockSetDefault = mock(() => new Promise<void>((r) => { resolveFirst = r }))

    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    pickModel('Site editor', 'claude-opus')

    // Click save — starts the request
    act(() => {
      const button = saveButton()
      fireEvent.click(button)
      fireEvent.click(button)
    })

    expect(saveButton().disabled).toBe(true)
    expect(saveButton().textContent).toContain('Saving')
    expect((screen.getByLabelText('Model for Site editor') as HTMLSelectElement).disabled).toBe(true)
    expect(mockSetDefault).toHaveBeenCalledTimes(1)

    // Complete the save
    await act(async () => { resolveFirst() })

    // Only one call was made
    expect(mockSetDefault).toHaveBeenCalledTimes(1)
  })

  it('clears pending state on complete success', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    pickModel('Site editor', 'claude-opus')
    await act(async () => { fireEvent.click(saveButton()) })

    // After success, save button should be disabled (no pending changes)
    await waitFor(() => expect(saveButton().disabled).toBe(true))
    expect(screen.getByRole('alert').textContent).toContain('Defaults saved')
  })

  it('preserves failed changes and reports the error on partial failure', async () => {
    let callCount = 0
    mockSetDefault = mock(async (scope: string) => {
      callCount++
      if (scope === 'content') throw new Error('Server error for content')
    })

    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    // Change two scopes
    pickModel('Site editor', 'claude-opus')
    selectScope('Content')
    await waitFor(() => expect(screen.getByLabelText('Model for Content')).toBeTruthy())
    pickModel('Content', 'claude-sonnet')

    await act(async () => { fireEvent.click(saveButton()) })

    // Both were attempted
    expect(callCount).toBe(2)

    const partialFailure = screen.getByRole('alert')
    expect(partialFailure.textContent).toContain('Some defaults could not be saved')
    expect(partialFailure.textContent).toContain('Content')
    expect(partialFailure.textContent).not.toContain('Defaults saved')

    // The Save button should still be enabled because the failed scope remains dirty
    await waitFor(() => expect(saveButton().disabled).toBe(false))

    // Switch to Content — the failed override should still be present
    selectScope('Content')
    await waitFor(() => expect(screen.getByLabelText('Model for Content')).toBeTruthy())
    const picker = screen.getByLabelText('Model for Content') as HTMLSelectElement
    expect(picker.value).toBe('cred-a::claude-sonnet')

    expect(screen.getAllByLabelText('unsaved changes')).toHaveLength(1)
    const siteButton = screen.getByRole('button', { name: /Site editor/ })
    expect(siteButton.textContent).toContain('claude-opus')

    mockSetDefault = mock(async () => {})
    await act(async () => { fireEvent.click(saveButton()) })
    expect(mockSetDefault).toHaveBeenCalledTimes(1)
    expect(mockSetDefault.mock.calls[0]![0]).toBe('content')
    expect(screen.getAllByRole('alert').at(-1)?.textContent).toContain('Defaults saved')
  })

  it('keeps the clear-default behaviour working', async () => {
    resetApiMocks({ site: { credentialId: 'cred-a', modelId: 'claude-opus' } })

    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    const clearButton = screen.getByRole('button', { name: /clear/i })
    await act(async () => { fireEvent.click(clearButton) })

    expect(mockClearDefault).toHaveBeenCalledTimes(1)
    expect(mockClearDefault.mock.calls[0]![0]).toBe('site')
  })

  it('does not discard pending changes for other scopes when clearing one scope', async () => {
    resetApiMocks({ site: { credentialId: 'cred-a', modelId: 'claude-opus' } })

    renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())

    // Pending change on Data
    selectScope('Data')
    await waitFor(() => expect(screen.getByLabelText('Model for Data')).toBeTruthy())
    pickModel('Data', 'claude-haiku')

    // Switch back to Site and clear its default
    selectScope('Site editor')
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())
    const clearButton = screen.getByRole('button', { name: /clear/i })
    await act(async () => { fireEvent.click(clearButton) })

    // Data's pending selection should survive
    selectScope('Data')
    await waitFor(() => expect(screen.getByLabelText('Model for Data')).toBeTruthy())
    const picker = screen.getByLabelText('Model for Data') as HTMLSelectElement
    expect(picker.value).toBe('cred-a::claude-haiku')

    // Save should still work for the remaining pending change
    expect(saveButton().disabled).toBe(false)
  })

  it('does not show completion feedback after unmount', async () => {
    let resolveSave!: () => void
    mockSetDefault = mock(() => new Promise<void>((resolve) => { resolveSave = resolve }))
    const view = renderTab()
    await waitFor(() => expect(screen.getByLabelText('Model for Site editor')).toBeTruthy())
    pickModel('Site editor', 'claude-opus')
    act(() => { fireEvent.click(saveButton()) })

    view.unmount()
    await act(async () => { resolveSave() })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
