import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DateTimePicker } from '@ui/components/DateTimePicker'
import { Button } from '@ui/components/Button'
import { SchedulePublishDialog } from '@admin/modals/SchedulePublishDialog'
import { StepUpProvider } from '@admin/shared/StepUp'
import { AdminSessionProvider } from '@admin/session'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { useContentMoveConfirmation } from '@admin/pages/content/hooks/useContentMoveConfirmation'
import { makeContentLocalization, SOURCE_LOCALE } from '../../fixtures/localization'
import { PublishButton } from '@site/toolbar/PublishButton'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../../fixtures'
import type { DataRow } from '@core/data/schemas'

const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; useEditorStore.setState({ site: null, activePageId: null, activeLocaleId: null }) })
const future = '2027-12-01T14:30:00.000Z'
const row: DataRow = {
  id: 'entry', tableId: 'posts', localeId: 'de', cells: { title: 'Eintrag' }, sharedCells: {},
  localization: makeContentLocalization('entry', { localeId: 'de', cells: { title: 'Eintrag' }, slug: 'eintrag' }),
  slug: 'eintrag', publicPath: null, status: 'scheduled', scheduledPublishAt: future,
  createdAt: future, updatedAt: future, publishedAt: null, deletedAt: null,
  authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null,
  author: null, createdBy: null, updatedBy: null, publishedBy: null,
}
function MoveControl({ commit }: { commit: () => Promise<void> }) {
  const confirmMove = useContentMoveConfirmation()
  return <ConfirmDeleteProvider><Button onClick={() => { void confirmMove(row, 'News', commit) }}>Move collection</Button></ConfirmDeleteProvider>
}

describe('language publication controls', () => {
  it('disables keyboard confirmation and every picker control while saving', () => {
    let confirms = 0
    render(<DateTimePicker value={new Date(future)} busy onConfirm={() => { confirms++ }} onCancel={() => {}} />)
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Hours') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Minutes') as HTMLInputElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Enter' })
    expect(confirms).toBe(0)
  })
  it('submits one locale schedule despite two immediate confirmations and keeps the existing date', async () => {
    const requests: string[] = []
    let finish!: (response: Response) => void
    globalThis.fetch = async (input) => { requests.push(String(input)); return new Promise<Response>((resolve) => { finish = resolve }) }
    const scheduled: DataRow[] = []
    let closed = 0
    render(<AdminSessionProvider user={null}><StepUpProvider><SchedulePublishDialog open rowId="entry" localeId="de" currentScheduledAt={future} entityLabel="post" onClose={() => { closed++ }} onScheduled={(value) => scheduled.push(value)} /></StepUpProvider></AdminSessionProvider>)
    expect(screen.getByText('Reschedule this post')).toBeTruthy()
    expect(screen.getByRole('grid').getAttribute('aria-label')).toBe('December 2027 days')
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
    await waitFor(() => expect(requests).toEqual(['/admin/api/cms/data/rows/entry/schedule?localeId=de']))
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancel current schedule' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { finish(new Response(JSON.stringify({ row }), { headers: { 'content-type': 'application/json' } })) })
    await waitFor(() => expect(scheduled).toHaveLength(1))
    expect(closed).toBe(1)
  })
  it('loads the selected page language schedule before opening the calendar', async () => {
    const site = makeSite()
    site.localeId = 'de'
    site.locales = [SOURCE_LOCALE, { ...SOURCE_LOCALE, id: 'de', code: 'de', name: 'Deutsch', pathPrefix: 'de', isDefault: false }]
    const pageId = site.pages[0].id
    useEditorStore.setState({ site, activePageId: pageId, activeLocaleId: 'de' })
    const requested: string[] = []
    globalThis.fetch = async (input) => {
      const url = String(input); requested.push(url)
      return new Response(JSON.stringify(url.includes('/publish/status')
        ? { hasPublishedVersion: false, draftMatchesPublished: false, draftPages: 1, publishedPages: 0 }
        : { row: { ...row, id: pageId, tableId: 'pages' } }), { headers: { 'content-type': 'application/json' } })
    }
    render(<AdminSessionProvider user={null}><StepUpProvider><PublishButton /></StepUpProvider></AdminSessionProvider>)
    fireEvent.click(screen.getByTestId('toolbar-publish-actions-trigger'))
    fireEvent.click(screen.getByTestId('toolbar-schedule-publish-action'))
    expect(await screen.findByText('Reschedule this page')).toBeTruthy()
    expect(requested).toContain(`/admin/api/cms/data/rows/${pageId}?localeId=de`)
    expect(screen.getByRole('grid').getAttribute('aria-label')).toBe('December 2027 days')
  })

  it('does not open a schedule response after the editor switched languages', async () => {
    const site = makeSite()
    site.localeId = 'de'; site.locales = [SOURCE_LOCALE, { ...SOURCE_LOCALE, id: 'de', code: 'de', name: 'Deutsch', pathPrefix: 'de', isDefault: false }]
    useEditorStore.setState({ site, activePageId: site.pages[0].id, activeLocaleId: 'de' })
    let finish!: (response: Response) => void
    globalThis.fetch = async (input) => String(input).includes('/publish/status')
      ? new Response(JSON.stringify({ hasPublishedVersion: false, draftMatchesPublished: false, draftPages: 1, publishedPages: 0 }), { headers: { 'content-type': 'application/json' } })
      : new Promise<Response>((resolve) => { finish = resolve })
    render(<AdminSessionProvider user={null}><StepUpProvider><PublishButton /></StepUpProvider></AdminSessionProvider>)
    fireEvent.click(screen.getByTestId('toolbar-publish-actions-trigger'))
    fireEvent.click(screen.getByTestId('toolbar-schedule-publish-action'))
    await waitFor(() => expect(finish).toBeDefined())
    act(() => useEditorStore.setState({ activeLocaleId: 'default' }))
    await act(async () => finish(new Response(JSON.stringify({ row }), { headers: { 'content-type': 'application/json' } })))
    expect(screen.queryByText('Reschedule this page')).toBeNull()
  })

  it('uses one confirmation host and explains that collection moves retract every language', async () => {
    let moves = 0
    render(<ConfirmDeleteProvider><MoveControl commit={async () => { moves++ }} /></ConfirmDeleteProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Move collection' }))
    expect(moves).toBe(0)
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
    expect(screen.getByText(/All language versions will go offline/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(moves).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Move collection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move entry' }))
    await waitFor(() => expect(moves).toBe(1))
  })
})
