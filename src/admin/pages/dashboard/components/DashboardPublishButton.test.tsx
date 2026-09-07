import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AdminSessionContext } from '@admin/sessionContext'
import { StepUpContext, type StepUpContextValue, StepUpCancelledMessage } from '@admin/shared/StepUp/StepUpContext'
import { CMS_PUBLICATION_CHANGED_EVENT } from '@admin/state/adminEvents'
import type { CmsCurrentUser } from '@core/persistence'
import type { PublicationOverview } from '@core/localization-schema'
import * as toasts from '@ui/components/Toast'
import { DashboardPublishButton } from './DashboardPublishButton'

const realFetch = globalThis.fetch
const overview: PublicationOverview = {
  locales: [
    { id: 'en', code: 'en', name: 'English', pathPrefix: '', enabled: true, isDefault: true, direction: 'ltr' },
    { id: 'de', code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, isDefault: false, direction: 'ltr' },
    { id: 'fr', code: 'fr', name: 'Français', pathPrefix: 'fr', enabled: false, isDefault: false, direction: 'ltr' },
  ],
  variants: [
    { rowId: 'home', localeId: 'en', title: 'Home', slug: 'index', isTemplate: false, availability: 'offline', scheduledPublishAt: null, publicPath: null },
    { rowId: 'home', localeId: 'de', title: 'Startseite', slug: 'index', isTemplate: false, availability: 'offline', scheduledPublishAt: null, publicPath: null },
    { rowId: 'home', localeId: 'fr', title: 'Accueil', slug: 'index', isTemplate: false, availability: 'offline', scheduledPublishAt: null, publicPath: null },
  ],
}

function renderButton(canPublish = true, runStepUp: StepUpContextValue['runStepUp'] = (action) => action()) {
  const user = { capabilities: canPublish ? ['pages.publish'] : [] } as CmsCurrentUser
  return render(<AdminSessionContext.Provider value={{ user, setUser: () => {} }}>
    <StepUpContext.Provider value={{ runStepUp }}><DashboardPublishButton /></StepUpContext.Provider>
  </AdminSessionContext.Provider>)
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('Dashboard language publication', () => {
  it('offers publication only to a user with the publication capability', () => {
    renderButton(false)
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull()
  })

  it('publishes only the explicitly selected language through step-up and refreshes dashboard data', async () => {
    const bodies: unknown[] = []
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json({ publishedPages: 1 })
      }
      return Response.json(overview)
    }) as typeof fetch
    const stepUp = mock(async <T,>(action: () => Promise<T>) => action())
    const changed = mock(() => {})
    const toast = spyOn(toasts, 'pushToast').mockReturnValue('test-toast')
    window.addEventListener(CMS_PUBLICATION_CHANGED_EVENT, changed)
    try {
      renderButton(true, stepUp)
      fireEvent.click(screen.getByRole('button', { name: 'Publish pages…' }))
      const target = await screen.findByRole('checkbox', { name: /Startseite/ })
      expect((screen.getByRole('checkbox', { name: /Accueil/ }) as HTMLInputElement).disabled).toBe(true)
      expect(bodies).toEqual([])
      fireEvent.click(target)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Publish 1 version' })))
      await waitFor(() => expect(bodies).toEqual([{ variants: [{ rowId: 'home', localeId: 'de' }] }]))
      expect(stepUp).toHaveBeenCalledTimes(1)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(toast).toHaveBeenCalledWith({ kind: 'success', title: 'Selected page versions published' })
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      window.removeEventListener(CMS_PUBLICATION_CHANGED_EVENT, changed)
      toast.mockRestore()
    }
  })

  it('keeps the selection open and reports a failed publication', async () => {
    globalThis.fetch = (async (_url, init) => init?.method === 'POST'
      ? Response.json({ error: 'Language route conflicts with another page.' }, { status: 409 })
      : Response.json(overview)) as typeof fetch
    const toast = spyOn(toasts, 'pushToast').mockReturnValue('test-toast')
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Publish pages…' }))
      fireEvent.click(await screen.findByRole('checkbox', { name: /Startseite/ }))
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Publish 1 version' })))
      await waitFor(() => expect(toast).toHaveBeenCalledWith({ kind: 'error', title: 'Publish failed', body: 'Language route conflicts with another page.' }))
      expect(screen.getByRole('dialog')).toBeDefined()
    } finally {
      toast.mockRestore()
      errorLog.mockRestore()
    }
  })

  it('lets a template publish independently and identifies that it has no direct URL', async () => {
    const bodies: unknown[] = []
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json({ publishedPages: 0 })
      }
      return Response.json({ ...overview, variants: [...overview.variants,
        { rowId: 'post-template', localeId: 'en', title: 'Post template', slug: 'post-template', isTemplate: true, availability: 'offline', scheduledPublishAt: null, publicPath: null },
      ] })
    }) as typeof fetch
    renderButton()
    fireEvent.click(screen.getByRole('button', { name: 'Publish pages…' }))
    const template = await screen.findByRole('checkbox', { name: /Post template/ })
    expect(screen.getByText('Template · no direct URL')).toBeDefined()
    expect(screen.queryByText('/post-template')).toBeNull()
    fireEvent.click(template)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Publish 1 version' })))
    await waitFor(() => expect(bodies).toEqual([{ variants: [{ rowId: 'post-template', localeId: 'en' }] }]))
  })

  it('retains the selection when password confirmation is cancelled without publishing', async () => {
    const writes = mock(() => {})
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'POST') writes()
      return Response.json(overview)
    }) as typeof fetch
    const toast = spyOn(toasts, 'pushToast').mockReturnValue('test-toast')
    try {
      renderButton(true, async () => { throw new Error(StepUpCancelledMessage) })
      fireEvent.click(screen.getByRole('button', { name: 'Publish pages…' }))
      fireEvent.click(await screen.findByRole('checkbox', { name: /Startseite/ }))
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Publish 1 version' })))
      expect(writes).not.toHaveBeenCalled()
      expect(toast).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog')).toBeDefined()
    } finally { toast.mockRestore() }
  })
})
