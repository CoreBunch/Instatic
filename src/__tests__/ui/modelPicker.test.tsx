import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelPicker, type ModelChoice } from '@admin/ai/ModelPicker'
import { clearModelListCache, type CredentialView } from '@admin/ai/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  clearModelListCache()
})

function credential(over: Partial<CredentialView> = {}): CredentialView {
  return {
    id: 'cred-or',
    providerId: 'openrouter',
    authMode: 'api_key',
    displayLabel: 'OpenRouter key',
    baseUrl: null,
    keyFingerprintCurrent: true,
    createdAt: '2026-01-01T00:00:00Z',
    lastUsedAt: null,
    ...over,
  } as CredentialView
}

// 12 models (> the default search threshold of 8) so the in-menu search box
// auto-enables — mirrors OpenRouter's long model list.
const MODELS = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`,
  label: i === 3 ? 'Claude Opus' : i === 4 ? 'Claude Sonnet' : `Model ${i}`,
  capabilities: { toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true },
}))

function mockModelsFetch() {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ models: MODELS }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as typeof fetch
}

describe('ModelPicker', () => {
  beforeEach(() => {
    clearModelListCache()
    mockModelsFetch()
  })

  it('renders the field trigger with a placeholder when nothing is selected', () => {
    render(
      <ModelPicker
        variant="field"
        ariaLabel="Model for site"
        placeholder="Choose a model"
        credentials={[credential()]}
        credentialsLoaded
        value={null}
        onChange={() => {}}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Model for site' })
    expect(trigger.textContent).toContain('Choose a model')
  })

  it('shares and briefly caches a credential catalogue across picker instances', async () => {
    const selected = { credentialId: 'cred-or', modelId: 'm0' }
    const { rerender } = render(
      <ModelPicker
        credentials={[credential()]}
        credentialsLoaded
        value={selected}
        onChange={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('Model 0'))
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)

    rerender(
      <div>
        <ModelPicker
          credentials={[credential()]}
          credentialsLoaded
          value={selected}
          onChange={() => {}}
        />
        <ModelPicker
          credentials={[credential()]}
          credentialsLoaded
          value={selected}
          onChange={() => {}}
        />
      </div>,
    )
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2))
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('opens a searchable, grouped menu and filters models by query', async () => {
    render(
      <ModelPicker
        variant="field"
        ariaLabel="Model for site"
        credentials={[credential()]}
        credentialsLoaded
        value={null}
        onChange={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model for site' }))

    // Models load via the mocked fetch; wait for the full list to render.
    await waitFor(() => expect(screen.getAllByRole('menuitemradio')).toHaveLength(12))

    const search = screen.getByRole('combobox', { name: /search/i })
    fireEvent.change(search, { target: { value: 'claude' } })

    const filtered = screen.getAllByRole('menuitemradio')
    expect(filtered).toHaveLength(2)
    expect(filtered.map((o) => o.textContent)).toEqual(['Claude Opus', 'Claude Sonnet'])
  })

  it('commits a (credential, model) choice on click', async () => {
    let picked: ModelChoice | null = null
    render(
      <ModelPicker
        variant="field"
        ariaLabel="Model for site"
        credentials={[credential()]}
        credentialsLoaded
        value={null}
        onChange={(choice) => {
          picked = choice
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model for site' }))
    await waitFor(() => expect(screen.getAllByRole('menuitemradio').length).toBeGreaterThan(0))

    fireEvent.change(screen.getByRole('combobox', { name: /search/i }), {
      target: { value: 'sonnet' },
    })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude Sonnet' }))

    expect(picked).toEqual({ credentialId: 'cred-or', modelId: 'm4' })
    // Menu closes after a pick.
    expect(screen.queryByRole('menuitemradio')).toBeNull()
  })

  it('commits the highlighted match on Enter from the search box', async () => {
    let picked: ModelChoice | null = null
    render(
      <ModelPicker
        variant="field"
        ariaLabel="Model for site"
        credentials={[credential()]}
        credentialsLoaded
        value={null}
        onChange={(choice) => {
          picked = choice
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model for site' }))
    await waitFor(() => expect(screen.getAllByRole('menuitemradio').length).toBeGreaterThan(0))

    const search = screen.getByRole('combobox', { name: /search/i })
    fireEvent.change(search, { target: { value: 'opus' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(picked).toEqual({ credentialId: 'cred-or', modelId: 'm3' })
  })

  it('shows a static state when there are no credentials', () => {
    render(
      <ModelPicker
        variant="field"
        credentials={[]}
        credentialsLoaded
        value={null}
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('No credentials yet')).toBeDefined()
  })
})
