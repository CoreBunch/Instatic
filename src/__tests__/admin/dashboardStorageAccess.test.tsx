import { afterEach, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { StorageWidget } from '@admin/pages/dashboard/widgets/StorageWidget'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('storage widget finishes loading with a permission message after HTTP 403', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Forbidden' }), {
    status: 403, headers: { 'content-type': 'application/json' },
  })
  const { container } = render(<StorageWidget span={12} editing={false} />)
  expect(container.querySelector('[data-widget="storage"]')?.getAttribute('aria-busy')).toBe('true')
  await screen.findByText("You don't have permission to view storage usage.")
  expect(container.querySelector('[data-widget="storage"]')?.hasAttribute('aria-busy')).toBe(false)
  expect(screen.queryByText(/self-hosted/)).toBeNull()
})

test('storage widget renders authorized usage after HTTP 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    imageBytes: 1024, videoBytes: 0, documentBytes: 0, pluginBytes: 0,
    databaseBytes: 1024, totalBytes: 2048, dialect: 'sqlite',
  }), { headers: { 'content-type': 'application/json' } })
  const { container } = render(<StorageWidget span={12} editing={false} />)
  await screen.findByText('2 KB')
  expect(screen.getByText('used · SQLite · self-hosted')).toBeTruthy()
  expect(container.querySelector('[data-widget="storage"]')?.hasAttribute('aria-busy')).toBe(false)
})
