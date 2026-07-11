import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import { AgentStoreProvider } from '@admin/ai/AgentStoreContext'
import { clearModelListCache } from '@admin/ai/api'
import { MemoryRouter, useLocation } from '@admin/lib/routing'
import { AdminSessionProvider } from '@admin/session'
import type { AgentSlice } from '@site/agent'
import type { AiUserContentBlock } from '@core/ai'
import type { CmsCurrentUser } from '@core/persistence'
import { AgentPanel } from '@site/panels/AgentPanel'

const originalFetch = globalThis.fetch

const TEST_CREDENTIAL = {
  id: 'cred_1',
  providerId: 'openai',
  authMode: 'apiKey',
  displayLabel: 'OpenAI',
  baseUrl: null,
  keyFingerprintCurrent: true,
  createdAt: '2026-06-01T10:00:00.000Z',
  lastUsedAt: null,
} as const

function installModelFetch(visionInput: boolean, toolCalling = true): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/admin/api/ai/credentials')) {
      return jsonResponse({ credentials: [TEST_CREDENTIAL] })
    }
    if (url.includes('/admin/api/ai/providers/')) {
      return jsonResponse({
        models: [{
          id: 'model-1',
          label: 'Model 1',
          capabilities: {
            toolCalling,
            visionInput,
            toolResultImages: false,
            promptCache: false,
            streaming: true,
          },
          contextWindow: 128_000,
        }],
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }) as typeof fetch
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

interface ImageBrowserMocks {
  bitmap: ImageBitmap
  restore(): void
}

let activeImageMocks: ImageBrowserMocks | null = null

function installImageBrowserMocks(
  bitmapPromise: Promise<ImageBitmap> = Promise.resolve(fakeBitmap()),
): ImageBrowserMocks {
  activeImageMocks?.restore()
  const canvasPrototype = Object.getPrototypeOf(document.createElement('canvas')) as object
  const createBitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  const getContextDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, 'getContext')
  const toBlobDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, 'toBlob')
  const bitmap = fakeBitmap()

  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: mock(() => bitmapPromise),
  })
  Object.defineProperty(canvasPrototype, 'getContext', {
    configurable: true,
    value: () => ({
      fillStyle: '',
      fillRect: () => {},
      drawImage: () => {},
    }),
  })
  Object.defineProperty(canvasPrototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }))
    },
  })
  const installed: ImageBrowserMocks = {
    bitmap,
    restore() {
      restoreProperty(globalThis, 'createImageBitmap', createBitmapDescriptor)
      restoreProperty(canvasPrototype, 'getContext', getContextDescriptor)
      restoreProperty(canvasPrototype, 'toBlob', toBlobDescriptor)
    },
  }
  activeImageMocks = installed
  return installed
}

function fakeBitmap(): ImageBitmap {
  return {
    width: 100,
    height: 80,
    close: mock(() => {}),
  } as unknown as ImageBitmap
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createAgentStore(overrides: Partial<AgentSlice> = {}) {
  return createStore<AgentSlice>()((set) => ({
    isAgentOpen: true,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    agentConversationId: null,
    agentActiveCredentialId: null,
    agentActiveModelId: null,
    agentConversations: [],
    agentContextTokens: null,
    isAgentConversationPending: false,
    isAgentProviderPending: false,
    agentComposerEpoch: 0,
    openAgent: () => set({ isAgentOpen: true }),
    closeAgent: () => set({ isAgentOpen: false }),
    toggleAgent: () => set((state) => ({ isAgentOpen: !state.isAgentOpen })),
    sendAgentMessage: async () => ({ accepted: true }),
    abortAgent: () => {},
    clearAgentMessages: () => set((state) => ({
      agentMessages: [],
      agentError: null,
      agentComposerEpoch: state.agentComposerEpoch + 1,
    })),
    loadAgentConversations: async () => {},
    loadAgentConversation: async () => {},
    startNewAgentConversation: () => set((state) => ({
      agentMessages: [],
      agentError: null,
      agentComposerEpoch: state.agentComposerEpoch + 1,
    })),
    deleteAgentConversation: async () => {},
    setAgentProvider: async (credentialId, modelId) => {
      set({ agentActiveCredentialId: credentialId, agentActiveModelId: modelId, agentError: null })
    },
    loadScopeDefault: async () => {},
    ...overrides,
  }))
}

function renderAgentPanel(overrides: Partial<AgentSlice> = {}) {
  const store = createAgentStore(overrides)
  const view = render(
    <AdminSessionProvider user={testUser()}>
      <MemoryRouter initialEntries={['/admin/site']}>
        <AgentStoreProvider store={store}>
          <AgentPanel variant="docked" />
          <RouteProbe />
        </AgentStoreProvider>
      </MemoryRouter>
    </AdminSessionProvider>,
  )
  return { ...view, store }
}

function testUser(): CmsCurrentUser {
  return {
    id: 'user-agent-panel',
    email: 'agent@example.com',
    displayName: 'Agent User',
    status: 'active',
    role: {
      id: 'role-admin',
      slug: 'admin',
      name: 'Admin',
      description: 'Agent panel test role',
      isSystem: true,
      capabilities: ['ai.chat'],
    },
    capabilities: ['ai.chat'],
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordUpdatedAt: null,
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaRecoveryCodesRemaining: 0,
    stepUpAuthMode: 'password',
    stepUpWindowMinutes: 15,
    avatarMediaId: null,
    avatarUrl: null,
    gravatarHash: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function RouteProbe() {
  const location = useLocation()
  return <output aria-label="current route">{location.pathname}</output>
}

function pasteImage(fileName = 'clipboard.png'): void {
  const textarea = screen.getByLabelText('Message to AI assistant')
  fireEvent.paste(textarea, {
    clipboardData: {
      files: [new File([pngHeader(100, 80)], fileName, { type: 'image/png' })],
    },
  })
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('AgentPanel', () => {
  afterEach(() => {
    cleanup()
    activeImageMocks?.restore()
    activeImageMocks = null
    localStorage.clear()
    globalThis.fetch = originalFetch
    clearModelListCache()
  })

  it('surfaces a large setup empty state and header shortcut when no credentials exist', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) {
        return jsonResponse({ credentials: [] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    renderAgentPanel()

    await waitFor(() => {
      expect(screen.getByText('Connect an AI provider')).toBeTruthy()
    })

    const headerButton = screen.getByTestId('agent-settings-header-button')
    expect(headerButton.tagName).toBe('BUTTON')
    expect(headerButton.textContent?.trim()).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Open AI settings' }))
    await waitFor(() => {
      expect(screen.getByLabelText('current route').textContent).toBe('/admin/ai')
    })

    expect(screen.getByText('No credentials yet')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
  })

  it('shows the build prompt when a provider is active (default preloaded)', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) {
        return jsonResponse({
          credentials: [{
            id: 'cred_1',
            providerId: 'openai',
            authMode: 'apiKey',
            displayLabel: 'OpenAI',
            baseUrl: null,
            keyFingerprintCurrent: true,
            createdAt: '2026-06-01T10:00:00.000Z',
            lastUsedAt: null,
          }],
        })
      }
      if (url.includes('/admin/api/ai/providers/')) {
        return jsonResponse({ models: [] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    // Active credential + model stands in for a preloaded scope default.
    renderAgentPanel({ agentActiveCredentialId: 'cred_1', agentActiveModelId: 'gpt-4o' })

    await waitFor(() => {
      expect(screen.getByText("Describe what you want to build and I'll do it for you.")).toBeTruthy()
    })

    expect(screen.queryByText('Connect an AI provider')).toBeNull()
    expect(screen.queryByText('Choose a model to get started')).toBeNull()
    const textarea = screen.getByLabelText('Message to AI assistant') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    // Settings and new-chat shortcuts are always available in the header,
    // independent of credential state.
    expect(screen.getByTestId('agent-settings-header-button')).toBeTruthy()
    expect(screen.getByTestId('agent-new-chat-header-button')).toBeTruthy()
  })

  it('prompts to choose a model when credentials exist but no default is set', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) {
        return jsonResponse({
          credentials: [{
            id: 'cred_1',
            providerId: 'openai',
            authMode: 'apiKey',
            displayLabel: 'OpenAI',
            baseUrl: null,
            keyFingerprintCurrent: true,
            createdAt: '2026-06-01T10:00:00.000Z',
            lastUsedAt: null,
          }],
        })
      }
      if (url.includes('/admin/api/ai/providers/')) {
        return jsonResponse({ models: [] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    // No active credential/model and no default loaded → must choose a model.
    renderAgentPanel()

    await waitFor(() => {
      expect(screen.getByText('Choose a model to get started')).toBeTruthy()
    })

    expect(screen.queryByText('Connect an AI provider')).toBeNull()
    // The composer is locked until a model is chosen, so the user can't fall
    // into the old send-time "no provider" surprise.
    const textarea = screen.getByLabelText('Message to AI assistant') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    // The empty state links to AI settings to set a default.
    expect(screen.getByRole('button', { name: 'Set a default in AI settings' })).toBeTruthy()
  })

  it('preloads the scope default on open', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) {
        return jsonResponse({ credentials: [] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    let called = 0
    renderAgentPanel({ loadScopeDefault: async () => { called += 1 } })

    await waitFor(() => expect(called).toBeGreaterThan(0))
  })

  it('keeps the composer usable once a provider is active despite a stale no-provider error', async () => {
    // Reproduces issue #2: a prior send left a sticky "No AI provider
    // configured" error; the user then picked a model (active credential +
    // model staged). The setup lockout must NOT show — the composer is usable.
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) {
        return jsonResponse({
          credentials: [{
            id: 'cred_1',
            providerId: 'anthropic',
            authMode: 'apiKey',
            displayLabel: 'Anthropic',
            baseUrl: null,
            keyFingerprintCurrent: true,
            createdAt: '2026-06-01T10:00:00.000Z',
            lastUsedAt: null,
          }],
        })
      }
      if (url.includes('/admin/api/ai/providers/')) {
        return jsonResponse({ models: [] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    renderAgentPanel({
      agentActiveCredentialId: 'cred_1',
      agentActiveModelId: 'claude-sonnet-4-6',
      agentError: 'No AI provider configured for the content workspace.',
    })

    await waitFor(() => {
      expect(screen.getByText("Describe what you want to build and I'll do it for you.")).toBeTruthy()
    })

    // The setup empty state must not appear, and the composer textarea must be
    // enabled (not disabled by the stale error).
    expect(screen.queryByText('Connect an AI provider')).toBeNull()
    const textarea = screen.getByLabelText('Message to AI assistant') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
  })

  it('blocks same-tick paste + Enter, then sends a prepared image-only turn', async () => {
    installModelFetch(true)
    const decode = deferred<ImageBitmap>()
    const bitmap = fakeBitmap()
    installImageBrowserMocks(decode.promise)
    const sendAgentMessage = mock(async (_content: AiUserContentBlock[]) => ({ accepted: true }))
    renderAgentPanel({
      agentActiveCredentialId: TEST_CREDENTIAL.id,
      agentActiveModelId: 'model-1',
      sendAgentMessage,
    })

    const textarea = await screen.findByLabelText('Message to AI assistant')
    pasteImage()
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(sendAgentMessage).not.toHaveBeenCalled()
    expect(screen.getByText('Preparing…')).toBeTruthy()

    await act(async () => {
      decode.resolve(bitmap)
      await decode.promise
    })
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBeNull()
    })

    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(sendAgentMessage).toHaveBeenCalledTimes(1))
    expect(sendAgentMessage.mock.calls[0]?.[0]).toEqual([{
      kind: 'image',
      mimeType: 'image/jpeg',
      data: 'AQID',
    }])
    await waitFor(() => {
      expect(screen.queryByLabelText('Attached image: clipboard.png')).toBeNull()
    })
    expect((textarea as HTMLTextAreaElement).value).toBe('')
  })

  it('retains text and the prepared image when the request is rejected before acceptance', async () => {
    installModelFetch(true)
    installImageBrowserMocks()
    const sendAgentMessage = mock(async (_content: AiUserContentBlock[]) => ({ accepted: false }))
    renderAgentPanel({
      agentActiveCredentialId: TEST_CREDENTIAL.id,
      agentActiveModelId: 'model-1',
      sendAgentMessage,
    })

    const textarea = await screen.findByLabelText('Message to AI assistant') as HTMLTextAreaElement
    pasteImage('reference.png')
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBeNull()
    })
    fireEvent.change(textarea, { target: { value: 'Use this reference' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(sendAgentMessage).toHaveBeenCalledTimes(1))
    expect(sendAgentMessage.mock.calls[0]?.[0]).toEqual([
      { kind: 'text', text: 'Use this reference' },
      { kind: 'image', mimeType: 'image/jpeg', data: 'AQID' },
    ])
    expect(textarea.value).toBe('Use this reference')
    expect(screen.getByLabelText('Attached image: reference.png')).toBeTruthy()
  })

  it('keeps an attachment visible but disables send for a non-vision model', async () => {
    installModelFetch(false)
    installImageBrowserMocks()
    const sendAgentMessage = mock(async (_content: AiUserContentBlock[]) => ({ accepted: true }))
    renderAgentPanel({
      agentActiveCredentialId: TEST_CREDENTIAL.id,
      agentActiveModelId: 'model-1',
      sendAgentMessage,
    })

    await screen.findByLabelText('Message to AI assistant')
    pasteImage()

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Choose a vision-capable model or remove the image.',
    )
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByLabelText('Attached image: clipboard.png')).toBeTruthy()
    expect(sendAgentMessage).not.toHaveBeenCalled()
  })

  it('blocks send when the selected model is known not to support agent tools', async () => {
    installModelFetch(true, false)
    const sendAgentMessage = mock(async (_content: AiUserContentBlock[]) => ({ accepted: true }))
    renderAgentPanel({
      agentActiveCredentialId: TEST_CREDENTIAL.id,
      agentActiveModelId: 'model-1',
      sendAgentMessage,
    })

    const textarea = await screen.findByLabelText('Message to AI assistant')
    fireEvent.change(textarea, { target: { value: 'Inspect this page' } })
    await screen.findByText('Choose an agent-capable model that supports tool calling.')
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendAgentMessage).not.toHaveBeenCalled()
  })

  it('drops an in-flight attachment when an explicit conversation reset remounts the composer', async () => {
    installModelFetch(true)
    const decode = deferred<ImageBitmap>()
    const bitmap = fakeBitmap()
    installImageBrowserMocks(decode.promise)
    const { store } = renderAgentPanel({
      agentActiveCredentialId: TEST_CREDENTIAL.id,
      agentActiveModelId: 'model-1',
    })

    await screen.findByLabelText('Message to AI assistant')
    pasteImage('stale.png')
    expect(screen.getByLabelText('Attached image: stale.png')).toBeTruthy()

    act(() => {
      store.setState({ agentComposerEpoch: 1 })
    })
    expect(screen.queryByLabelText('Attached image: stale.png')).toBeNull()
    await act(async () => {
      decode.resolve(bitmap)
      await decode.promise
    })
    expect(screen.queryByLabelText('Attached image: stale.png')).toBeNull()
  })

  it('renders a rehydrated user image block in conversation history', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) return jsonResponse({ credentials: [] })
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    renderAgentPanel({
      agentMessages: [{
        id: 'image-message',
        role: 'user',
        blocks: [{ kind: 'image', mimeType: 'image/jpeg', data: 'QUJD' }],
        timestamp: Date.now(),
      }],
    })

    const image = await screen.findByAltText('Attachment from you') as HTMLImageElement
    expect(image.src).toContain('data:image/jpeg;base64,QUJD')
  })
})
