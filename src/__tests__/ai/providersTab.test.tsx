import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ProvidersTab } from '@admin/pages/ai/tabs/ProvidersTab'

const originalFetch = globalThis.fetch

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockEmptyCredentials() {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/admin/api/ai/credentials')) return json({ credentials: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

describe('ProvidersTab', () => {
  it('derives credential authentication from the selected provider', async () => {
    mockEmptyCredentials()

    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('No credentials yet. Add one to start using AI features.')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Add credential' }))

    const dialog = screen.getByRole('dialog', { name: 'Add AI credential' })
    expect(within(dialog).getByRole('combobox', { name: 'Provider' })).toBeDefined()
    expect(within(dialog).queryByLabelText('Authentication')).toBeNull()
    expect(within(dialog).getByLabelText('API key')).toBeDefined()
  })

  it('keeps Ollama on the endpoint credential shape without an auth-mode choice', async () => {
    mockEmptyCredentials()

    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('No credentials yet. Add one to start using AI features.')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Add credential' }))

    const dialog = screen.getByRole('dialog', { name: 'Add AI credential' })
    const provider = within(dialog).getByRole('combobox', { name: 'Provider' })
    fireEvent.click(provider.nextElementSibling as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'Ollama (local)' }))

    expect(within(dialog).queryByLabelText('Authentication')).toBeNull()
    expect(within(dialog).getByLabelText('Base URL')).toBeDefined()
    expect(within(dialog).getByLabelText('Bearer token (optional)')).toBeDefined()
    expect(within(dialog).queryByLabelText('API key')).toBeNull()
  })
})
