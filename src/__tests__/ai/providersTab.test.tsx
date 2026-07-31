import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

    render(<ProvidersTab onNavigateToDefaults={() => {}} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connect Anthropic' })).toBeDefined())

    expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull()
    expect(screen.queryByLabelText('Authentication')).toBeNull()
    expect(screen.getByLabelText('API key')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Credentials' })).toBeNull()
    expect(screen.queryByText('Secrets are encrypted at rest and never returned to the browser.')).toBeNull()
  })

  it('keeps Ollama on the endpoint credential shape without an auth-mode choice', async () => {
    mockEmptyCredentials()

    render(<ProvidersTab onNavigateToDefaults={() => {}} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connect Anthropic' })).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /Ollama Local models/ }))

    expect(screen.getByRole('heading', { name: 'Connect Ollama' })).toBeDefined()
    expect(screen.queryByLabelText('Authentication')).toBeNull()
    expect(screen.getByLabelText('Base URL')).toBeDefined()
    expect(screen.getByLabelText(/Bearer token/)).toBeDefined()
    expect(screen.queryByLabelText('API key')).toBeNull()
  })

  it('opens configured credentials in the detail inspector', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) {
        return json({
          credentials: [{
            id: 'cred-1',
            providerId: 'anthropic',
            authMode: 'apiKey',
            displayLabel: 'Production Claude',
            baseUrl: null,
            keyFingerprintCurrent: true,
            createdAt: '2026-07-13T10:00:00.000Z',
            lastUsedAt: null,
          }],
        })
      }
      if (url.includes('/admin/api/ai/providers/anthropic/models')) {
        return json({
          models: [{
            id: 'claude-sonnet-4',
            label: 'Claude Sonnet 4',
            capabilities: {
              toolCalling: true,
              visionInput: true,
              toolResultImages: true,
              promptCache: true,
              streaming: true,
            },
            contextWindow: 200000,
          }],
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    render(<ProvidersTab onNavigateToDefaults={() => {}} />)

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Production Claude' })).toBeDefined())
    await waitFor(() => expect(screen.getByText('Claude Sonnet 4')).toBeDefined())
    expect(screen.getByText('200K tokens')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDefined()
  })
})
