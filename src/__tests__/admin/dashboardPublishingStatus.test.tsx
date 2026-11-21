import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PublishingStatusWidget } from '@admin/pages/dashboard/widgets/PublishingStatusWidget'

const originalFetch = globalThis.fetch
const unpublished = {
  hasPublishedVersion: false,
  draftMatchesPublished: false,
  draftPages: 1,
  publishedPages: 0,
}

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('publishing status shows when there is no published version', async () => {
  globalThis.fetch = async () => Response.json(unpublished)

  render(<PublishingStatusWidget span={3} editing={false} />)

  expect(await screen.findByText('Not published')).toBeTruthy()
  expect(screen.queryByText(/Last published/)).toBeNull()
})

test.each([
  [true, 'Site draft is up to date.'],
  [false, 'Unpublished site changes.'],
])('published site with matching draft %s shows the draft state and timestamp', async (draftMatchesPublished, label) => {
  const lastPublishedAt = '2026-01-03T12:00:00.000Z'
  globalThis.fetch = async () => Response.json({
    hasPublishedVersion: true,
    draftMatchesPublished,
    draftPages: 1,
    publishedPages: 1,
    lastPublishedAt,
  })

  const { container } = render(<PublishingStatusWidget span={3} editing={false} />)

  expect(await screen.findByText(label)).toBeTruthy()
  expect(screen.getByText('Published', { exact: true })).toBeTruthy()
  expect(container.querySelector('time')?.dateTime).toBe(lastPublishedAt)
})

test('a dashboard viewer without site access sees a permission message', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Forbidden' }, { status: 403 })
  const { container } = render(<PublishingStatusWidget span={3} editing={false} />)

  expect((await screen.findByRole('status')).textContent).toBe('You don’t have permission to view publishing status.')
  expect(container.querySelector('[data-widget="status"]')?.hasAttribute('aria-busy')).toBe(false)
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

test('publishing status can retry a failed read', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status: 503 })
  render(<PublishingStatusWidget span={3} editing={false} />)

  expect((await screen.findByRole('status')).textContent).toBe('Couldn’t load publishing status.')
  globalThis.fetch = async () => Response.json(unpublished)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

  expect(await screen.findByText('Not published')).toBeTruthy()
})
