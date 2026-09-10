import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { notifyCmsPublicationChanged } from '@admin/state/adminEvents'
import { PagesWidget } from './PagesWidget'
import { PostsWidget } from './PostsWidget'
import { PublishQueueWidget } from './PublishQueueWidget'

const realFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = realFetch })

it('distinguishes logical totals and language versions, shows frozen addresses, and refreshes after publication', async () => {
  let loads = 0
  globalThis.fetch = (async (input) => {
    loads++
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.endsWith('/pages')) return Response.json({ total: 2, variants: 4, published: 1, drafts: 2, offline: 1, scheduled: 1, deltaPublishedThisWeek: 1 })
    if (path.endsWith('/posts')) return Response.json({ total: 3, variants: 5, categories: 1, scheduled: 2, daily28: Array(28).fill(0) })
    return Response.json({ rows: [
      { id: 'home', localeId: 'en', localeCode: 'en', localeEnabled: true, title: 'Home', path: '/released-home', status: 'published', at: null },
      { id: 'home', localeId: 'de', localeCode: 'de', localeEnabled: false, title: 'Startseite', path: '/de/geplant', status: 'scheduled', at: null },
      { id: 'home', localeId: 'de', localeCode: 'de', localeEnabled: false, title: 'Startseite', path: null, status: 'offline', at: null },
    ] })
  }) as typeof fetch
  render(<><PagesWidget span={3} editing={false} /><PostsWidget span={3} editing={false} /><PublishQueueWidget span={6} editing={false} /></>)
  await screen.findByText('/released-home')
  expect(screen.getByText('/de/geplant')).toBeDefined()
  expect(screen.getByText('2 pages · 4 language versions')).toBeDefined()
  expect(screen.getByText('Online language versions')).toBeDefined()
  expect(screen.getByText('5 language versions')).toBeDefined()
  expect(screen.getAllByText('Language offline')).toHaveLength(2)
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  await waitFor(() => expect(loads).toBe(3))
  await act(async () => notifyCmsPublicationChanged())
  await waitFor(() => expect(loads).toBe(6))
})
