/**
 * AccountPage — `/admin/account` self-targeted user settings.
 *
 * Verifies:
 *   - All four tab buttons render (Profile / Active devices / Security /
 *     Sign-in history)
 *   - Profile tab is the default and shows the current user's identity
 *   - Switching to Active devices renders the live session list (current pinned)
 *   - Switching to Security renders the four placeholder cards
 *   - Switching to Sign-in history renders the empty state when there's
 *     nothing to show, surfaces the suspicious banner on `locked` /
 *     `rate_limited` events,
 *     and shows the failed-attempt chip when there are recent failures
 *   - The Account workspace is accessible to a viewer-role user (no
 *     capability gating — self-targeted)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { canAccessWorkspace } from '@admin/access'
import { AccountPage } from '@admin/pages/account/AccountPage'
import { AdminSessionProvider } from '@admin/session'
import { StepUpProvider } from '@admin/shared/StepUp'
import { MemoryRouter } from '@admin/lib/routing'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'
import type { CmsCurrentUser, CmsSession } from '@core/persistence'
import '@modules/base/index'

const now = '2026-05-09T10:00:00.000Z'
const originalFetch = globalThis.fetch
type EventSourceCtor = (typeof globalThis) extends { EventSource: infer T } ? T : never
const originalEventSource = (globalThis as { EventSource?: EventSourceCtor }).EventSource
let eventSourceUrls: string[] = []

function makeUser(overrides: Partial<CmsCurrentUser> = {}): CmsCurrentUser {
  return {
    id: 'owner_1',
    email: 'owner@example.com',
    displayName: 'Olivia Owner',
    status: 'active',
    role: {
      id: 'owner',
      slug: 'owner',
      name: 'Owner',
      description: '',
      isSystem: true,
      capabilities: ['site.read'],
    },
    capabilities: ['site.read'],
    lastLoginAt: now,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordUpdatedAt: null,
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaRecoveryCodesRemaining: 0,
    stepUpAuthMode: 'required',
    stepUpWindowMinutes: 15,
    avatarMediaId: null,
    avatarUrl: null,
    gravatarHash: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeSession(overrides: Partial<CmsSession> = {}): CmsSession {
  return {
    id: 'sess_a',
    deviceLabel: 'Chrome on macOS',
    ipAddress: '203.0.113.10',
    userAgent: null,
    createdAt: '2026-05-09T09:00:00.000Z',
    lastSeenAt: '2026-05-09T09:55:00.000Z',
    expiresAt: '2026-06-08T09:00:00.000Z',
    isCurrent: true,
    mfaPassedAt: null,
    stepUpExpiresAt: null,
    ...overrides,
  }
}

function setupEditorState() {
  // AdminPageLayout (which wraps AccountPage) reads the site name from the
  // editor store for the toolbar, but doesn't gate rendering on the site
  // object. We still set a minimal site stub here to keep the store shape
  // consistent.
  const site = makeSite({ name: 'Account Test Site' })
  useEditorStore.setState({
    site,
    activePageId: site.pages[0].id,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeBreakpointId: 'desktop',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    leftSidebarWidth: 320,
    focusedPanel: 'canvas',
    selectorsPanelOpen: false,
    frameworkPanelOpen: false,
    codeEditorPanelOpen: false,
    activeEditorFileId: null,
    activeMediaAssetPreview: null,
    dependenciesPanelOpen: false,
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/**
 * happy-dom does not implement EventSource, but users with plugin access mount
 * the plugin event bridge from AdminPageLayout. Stub it with a no-op so the
 * bridge subscribes silently and the test can render the page.
 */
class StubEventSource {
  readonly url: string
  constructor(url: string) {
    this.url = url
    eventSourceUrls.push(url)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

function makeAccountFetch(
  overrides: (input: string, init?: RequestInit) => Response | undefined,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const override = overrides(url, init)
    if (override) return override
    // Fallbacks that keep AdminPageLayout's ambient calls happy. The Account
    // page itself never calls these, but the surrounding layout does.
    if (url.endsWith('/admin/api/cms/plugins')) return jsonResponse({ plugins: [], adminPages: [] })
    if (url.endsWith('/admin/api/cms/site')) return jsonResponse({ site: null }, 404)
    if (url.endsWith('/admin/api/cms/site/publish-status')) return jsonResponse({ ok: false }, 404)
    return jsonResponse({ error: `Unhandled ${url}` }, 500)
  }) as typeof fetch
}

function renderWithUser(user: CmsCurrentUser) {
  // AccountPage renders inside the same provider stack as production —
  // router (AdminRouteLink ↔ useAdminNavigate) and StepUpProvider
  // (Sessions tab calls useStepUp).
  return render(
    <MemoryRouter initialEntries={['/admin/account']}>
      <AdminSessionProvider user={user}>
        <StepUpProvider>
          <AccountPage />
        </StepUpProvider>
      </AdminSessionProvider>
    </MemoryRouter>,
  )
}

describe('AccountPage', () => {
  beforeEach(() => {
    localStorage.clear()
    setupEditorState()
    eventSourceUrls = []
    ;(globalThis as { EventSource?: unknown }).EventSource = StubEventSource as unknown
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    if (originalEventSource) {
      ;(globalThis as { EventSource?: unknown }).EventSource = originalEventSource
    } else {
      delete (globalThis as { EventSource?: unknown }).EventSource
    }
  })

  it('canAccessWorkspace allows account for any authenticated user', () => {
    const viewer = makeUser({
      role: { id: 'member', slug: 'member', name: 'Member', description: '', isSystem: true, capabilities: ['site.read'] },
      capabilities: ['site.read'],
    })
    expect(canAccessWorkspace(viewer, 'account')).toBe(true)

    // Anonymous (null user) is rejected.
    expect(canAccessWorkspace(null, 'account')).toBe(false)
  })

  it('does not start plugin background work for users without plugin access', async () => {
    const pluginRequests: string[] = []
    globalThis.fetch = makeAccountFetch((url) => {
      if (url.includes('/admin/api/cms/plugins')) {
        pluginRequests.push(url)
      }
      return undefined
    })

    renderWithUser(makeUser())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pluginRequests).toEqual([])
    expect(eventSourceUrls).toEqual([])
  })

  it('renders all four tabs and defaults to Profile', () => {
    globalThis.fetch = makeAccountFetch((url) => {
      if (url.endsWith('/admin/api/cms/auth/sessions')) return jsonResponse({ sessions: [] })
      return undefined
    })
    renderWithUser(makeUser())
    expect(screen.getByTestId('account-tab-profile')).toBeTruthy()
    expect(screen.getByTestId('account-tab-sessions')).toBeTruthy()
    expect(screen.getByTestId('account-tab-security')).toBeTruthy()
    expect(screen.getByTestId('account-tab-activity')).toBeTruthy()
    // Default tab is Profile — identity values are loaded into editable fields.
    expect(screen.getByTestId('profile-display-name').getAttribute('value')).toBe('Olivia Owner')
    expect(screen.getByTestId('profile-email').getAttribute('value')).toBe('owner@example.com')
  })

  it('Sessions tab renders the device list with the current session pinned', async () => {
    globalThis.fetch = makeAccountFetch((url) => {
      if (url.endsWith('/admin/api/cms/auth/sessions')) {
        return jsonResponse({
          sessions: [
            makeSession({ id: 'sess_a', deviceLabel: 'Chrome on macOS', isCurrent: true }),
            makeSession({ id: 'sess_b', deviceLabel: 'Safari on iOS', isCurrent: false }),
          ],
        })
      }
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-sessions'))

    await waitFor(() => {
      expect(screen.getByText('Chrome on macOS')).toBeTruthy()
      expect(screen.getByText('Safari on iOS')).toBeTruthy()
    })
    // Current session has no per-row sign-out button (revoke happens via toolbar).
    expect(screen.queryByTestId('account-sessions-sign-out-sess_a')).toBeNull()
    // Other sessions DO get a sign-out button.
    expect(screen.getByTestId('account-sessions-sign-out-sess_b')).toBeTruthy()
  })

  it('Security tab renders active security actions', () => {
    globalThis.fetch = makeAccountFetch((url) => {
      if (url.endsWith('/admin/api/cms/auth/sessions')) return jsonResponse({ sessions: [] })
      return undefined
    })
    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-security'))

    expect(screen.getByTestId('security-password-card')).toBeTruthy()
    expect(screen.getByTestId('security-step-up-card')).toBeTruthy()
    expect(screen.getByTestId('security-mfa-card')).toBeTruthy()
    expect(screen.getByTestId('security-recovery-card')).toBeTruthy()
    expect(screen.getByTestId('security-connected-card')).toBeTruthy()
    expect(screen.getByTestId('security-change-password')).toBeTruthy()
    expect(screen.getByTestId('security-step-up-toggle')).toBeTruthy()
    expect(screen.getByTestId('security-step-up-window')).toBeTruthy()
    expect(screen.getByTestId('security-mfa-enable')).toBeTruthy()
    expect(screen.getByTestId('security-recovery-regenerate')).toBeTruthy()
  })

  it('Security tab disables step-up through the shared step-up flow', async () => {
    let settingsPatchCalls = 0
    let lastBody: unknown = null
    globalThis.fetch = makeAccountFetch((url, init) => {
      if (url.endsWith('/admin/api/cms/me/security/step-up') && init?.method === 'PATCH') {
        settingsPatchCalls += 1
        lastBody = JSON.parse(String(init.body))
        if (settingsPatchCalls === 1) return jsonResponse({ error: 'step_up_required' }, 401)
        return jsonResponse({
          user: makeUser({
            stepUpAuthMode: 'disabled',
            stepUpWindowMinutes: 15,
          }),
        })
      }
      if (url.endsWith('/admin/api/cms/auth/step-up')) {
        return jsonResponse({ ok: true, stepUpExpiresAt: '2026-05-09T11:15:00.000Z' })
      }
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-security'))
    fireEvent.click(screen.getByTestId('security-step-up-toggle'))

    await waitFor(() => {
      expect(screen.getByTestId('step-up-dialog')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('step-up-password'), {
      target: { value: 'long-enough-password' },
    })
    fireEvent.click(screen.getByTestId('step-up-confirm'))

    await waitFor(() => {
      expect(screen.getByText('Step-up authentication disabled.')).toBeTruthy()
    })
    expect(settingsPatchCalls).toBe(2)
    expect(lastBody).toEqual({ mode: 'disabled', windowMinutes: 15 })
    expect(screen.getByText('Disabled')).toBeTruthy()
  })

  it('Security tab configures the step-up window', async () => {
    let lastBody: unknown = null
    globalThis.fetch = makeAccountFetch((url, init) => {
      if (url.endsWith('/admin/api/cms/me/security/step-up') && init?.method === 'PATCH') {
        lastBody = JSON.parse(String(init.body))
        return jsonResponse({
          user: makeUser({
            stepUpAuthMode: 'required',
            stepUpWindowMinutes: 30,
          }),
        })
      }
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-security'))
    fireEvent.click(screen.getByTestId('security-step-up-window'))
    fireEvent.click(screen.getByRole('option', { name: '30 minutes' }))

    await waitFor(() => {
      expect(screen.getByText('Step-up authentication updated to 30 minutes.')).toBeTruthy()
    })
    expect(lastBody).toEqual({ mode: 'required', windowMinutes: 30 })
  })

  it('Security tab changes password through the shared step-up flow', async () => {
    let passwordPatchCalls = 0
    globalThis.fetch = makeAccountFetch((url, init) => {
      if (url.endsWith('/admin/api/cms/me/password') && init?.method === 'PATCH') {
        passwordPatchCalls += 1
        if (passwordPatchCalls === 1) return jsonResponse({ error: 'step_up_required' }, 401)
        return jsonResponse({ user: makeUser({ passwordUpdatedAt: '2026-05-09T11:00:00.000Z' }) })
      }
      if (url.endsWith('/admin/api/cms/auth/step-up')) {
        return jsonResponse({ ok: true, stepUpExpiresAt: '2026-05-09T11:15:00.000Z' })
      }
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-security'))
    fireEvent.click(screen.getByTestId('security-change-password'))

    fireEvent.change(screen.getByTestId('security-password-new'), {
      target: { value: 'new-long-enough-password' },
    })
    fireEvent.change(screen.getByTestId('security-password-confirm'), {
      target: { value: 'new-long-enough-password' },
    })
    fireEvent.click(screen.getByTestId('security-password-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('step-up-dialog')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('step-up-password'), {
      target: { value: 'long-enough-password' },
    })
    fireEvent.click(screen.getByTestId('step-up-confirm'))

    await waitFor(() => {
      expect(screen.getByText('Password updated. Other devices were signed out.')).toBeTruthy()
    })
    expect(passwordPatchCalls).toBe(2)
  })

  it('Security tab enables MFA and shows one-time recovery codes', async () => {
    globalThis.fetch = makeAccountFetch((url, init) => {
      if (url.endsWith('/admin/api/cms/me/mfa/totp/start') && init?.method === 'POST') {
        return jsonResponse({
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUrl: 'otpauth://totp/Page%20Builder%20CMS:owner%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Page%20Builder%20CMS',
        })
      }
      if (url.endsWith('/admin/api/cms/me/mfa/totp/enable') && init?.method === 'POST') {
        return jsonResponse({
          user: makeUser({
            mfaEnabled: true,
            mfaEnabledAt: '2026-05-09T11:00:00.000Z',
            mfaRecoveryCodesRemaining: 10,
          }),
          recoveryCodes: ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'],
        })
      }
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-security'))
    fireEvent.click(screen.getByTestId('security-mfa-enable'))

    await waitFor(() => {
      expect(screen.getByTestId('security-mfa-secret').textContent).toContain('JBSWY3DPEHPK3PXP')
    })
    await waitFor(() => {
      const qrCode = screen.getByTestId('security-mfa-qr-code')
      expect(qrCode.getAttribute('alt')).toBe('Scan this QR code with your authenticator app')
      expect(qrCode.getAttribute('src')?.startsWith('data:image/')).toBe(true)
    })
    expect(screen.getByText('Scan the QR code')).toBeTruthy()
    fireEvent.change(screen.getByTestId('security-mfa-code'), {
      target: { value: '123456' },
    })
    fireEvent.click(screen.getByTestId('security-mfa-submit'))

    await waitFor(() => {
      expect(screen.getByText('Save these recovery codes now. They will not be shown again.')).toBeTruthy()
    })
    expect(screen.getByText('aaaa-bbbb-cccc')).toBeTruthy()
    expect(screen.getByText('dddd-eeee-ffff')).toBeTruthy()
  })

  it('Security tab keeps manual MFA setup usable when QR rendering fails', async () => {
    const originalEncodeURIComponent = globalThis.encodeURIComponent
    const originalConsoleError = console.error
    const qrLogs: unknown[][] = []
    const captureConsoleError: typeof console.error = (...args) => {
      qrLogs.push(args)
    }
    const globalEncoding = globalThis as typeof globalThis & {
      encodeURIComponent: typeof encodeURIComponent
    }
    globalEncoding.encodeURIComponent = (value) => {
      if (String(value).startsWith('<svg')) throw new Error('QR data URL encoding failed')
      return originalEncodeURIComponent(value)
    }
    console.error = captureConsoleError

    try {
      globalThis.fetch = makeAccountFetch((url, init) => {
        if (url.endsWith('/admin/api/cms/me/mfa/totp/start') && init?.method === 'POST') {
          return jsonResponse({
            secret: 'JBSWY3DPEHPK3PXP',
            otpauthUrl: 'otpauth://totp/Page%20Builder%20CMS:owner%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Page%20Builder%20CMS',
          })
        }
        if (url.endsWith('/admin/api/cms/me/mfa/totp/enable') && init?.method === 'POST') {
          return jsonResponse({
            user: makeUser({
              mfaEnabled: true,
              mfaEnabledAt: '2026-05-09T11:00:00.000Z',
              mfaRecoveryCodesRemaining: 10,
            }),
            recoveryCodes: ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'],
          })
        }
        return undefined
      })

      renderWithUser(makeUser())
      fireEvent.click(screen.getByTestId('account-tab-security'))
      fireEvent.click(screen.getByTestId('security-mfa-enable'))

      await waitFor(() => {
        expect(screen.getByText('QR code unavailable')).toBeTruthy()
      })
      expect(screen.getByRole('alert').textContent).toBe('Could not render the QR code. Use the setup key instead.')
      expect(screen.getByTestId('security-mfa-secret').textContent).toContain('JBSWY3DPEHPK3PXP')
      expect(screen.getByRole('link', { name: 'Open authenticator app' }).getAttribute('href')).toContain(
        'otpauth://totp/',
      )
      expect(qrLogs.some((args) => String(args[0]).includes('[account-security] QR code generation failed:'))).toBe(true)

      fireEvent.change(screen.getByTestId('security-mfa-code'), {
        target: { value: '123456' },
      })
      fireEvent.click(screen.getByTestId('security-mfa-submit'))

      await waitFor(() => {
        expect(screen.getByText('Save these recovery codes now. They will not be shown again.')).toBeTruthy()
      })
      expect(screen.getByText('aaaa-bbbb-cccc')).toBeTruthy()
      expect(screen.getByText('dddd-eeee-ffff')).toBeTruthy()
    } finally {
      globalEncoding.encodeURIComponent = originalEncodeURIComponent
      console.error = originalConsoleError
    }
  })

  it('Activity tab shows an empty state when there are no events', async () => {
    globalThis.fetch = makeAccountFetch((url) => {
      if (url.endsWith('/admin/api/cms/auth/activity')) return jsonResponse({ events: [] })
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-activity'))

    await waitFor(() => {
      expect(screen.getByText('No login activity yet.')).toBeTruthy()
    })
  })

  it('Activity tab surfaces a suspicious-activity banner when recent locked events exist', async () => {
    const recentLockTimestamp = new Date(Date.now() - 5 * 60_000).toISOString()
    globalThis.fetch = makeAccountFetch((url) => {
      if (url.endsWith('/admin/api/cms/auth/activity')) {
        return jsonResponse({
          events: [
            {
              id: 'a1',
              attemptedAt: recentLockTimestamp,
              emailNorm: 'owner@example.com',
              ipAddress: '198.51.100.99',
              deviceLabel: 'Chrome on macOS',
              userId: 'owner_1',
              result: 'locked',
            },
          ],
        })
      }
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-activity'))

    await waitFor(() => {
      expect(screen.getByTestId('account-activity-suspicious')).toBeTruthy()
    })
  })

  it('Activity tab treats recent rate-limited events as suspicious activity', async () => {
    const recentRateLimitTimestamp = new Date(Date.now() - 5 * 60_000).toISOString()
    globalThis.fetch = makeAccountFetch((url) => {
      if (url.endsWith('/admin/api/cms/auth/activity')) {
        return jsonResponse({
          events: [
            {
              id: 'a1',
              attemptedAt: recentRateLimitTimestamp,
              emailNorm: 'owner@example.com',
              ipAddress: '198.51.100.88',
              deviceLabel: 'Safari on iOS',
              userId: 'owner_1',
              result: 'rate_limited',
            },
          ],
        })
      }
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-activity'))

    await waitFor(() => {
      expect(screen.getByTestId('account-activity-suspicious')).toBeTruthy()
    })
    expect(screen.getByTestId('account-activity-failed-count').textContent).toBe('1 failed in last 24h')
    expect(screen.getByText('Rate-limited')).toBeTruthy()
    expect(screen.getByText('Safari on iOS')).toBeTruthy()
    expect(screen.getByText('198.51.100.88')).toBeTruthy()
  })

  it('Activity tab shows a failed-attempt count chip and the Device column', async () => {
    const recentFailure = new Date(Date.now() - 5 * 60_000).toISOString()
    const recentSuccess = new Date(Date.now() - 60_000).toISOString()
    globalThis.fetch = makeAccountFetch((url) => {
      if (url.endsWith('/admin/api/cms/auth/activity')) {
        return jsonResponse({
          events: [
            {
              id: 'a1',
              attemptedAt: recentFailure,
              emailNorm: 'owner@example.com',
              ipAddress: '198.51.100.99',
              deviceLabel: 'Firefox on Linux',
              userId: 'owner_1',
              result: 'bad_password',
            },
            {
              id: 'a2',
              attemptedAt: recentFailure,
              emailNorm: 'owner@example.com',
              ipAddress: '198.51.100.99',
              deviceLabel: '',
              userId: 'owner_1',
              result: 'bad_password',
            },
            {
              id: 'a3',
              attemptedAt: recentSuccess,
              emailNorm: 'owner@example.com',
              ipAddress: '198.51.100.10',
              deviceLabel: 'Chrome on macOS',
              userId: 'owner_1',
              result: 'success',
            },
          ],
        })
      }
      return undefined
    })

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-tab-activity'))

    await waitFor(() => {
      // The chip counts only failure outcomes within the 24h window. The
      // single successful login is excluded.
      expect(screen.getByTestId('account-activity-failed-count').textContent).toBe('2 failed in last 24h')
    })
    // Known device label is rendered as-is.
    expect(screen.getByText('Firefox on Linux')).toBeTruthy()
    // Successful event also gets a device label rendered.
    expect(screen.getByText('Chrome on macOS')).toBeTruthy()
    // Empty deviceLabel falls back to the "Unknown device" placeholder.
    expect(screen.getAllByText('Unknown device').length).toBeGreaterThan(0)
  })
})
