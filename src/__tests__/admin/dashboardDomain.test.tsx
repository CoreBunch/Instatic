import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DomainWidget } from '@admin/pages/dashboard/widgets/DomainWidget'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('domain widget shows the configured host and port with the HTTPS label', async () => {
  const publicOrigin = 'https://public.example.test:8443'
  globalThis.fetch = async () => Response.json({ publicOrigin })

  render(<DomainWidget span={6} editing={false} />)

  expect(await screen.findByText('public.example.test:8443')).toBeTruthy()
  expect(screen.getByText('HTTPS configured')).toBeTruthy()
})

test('domain widget shows setup guidance when the public origin is unset', async () => {
  globalThis.fetch = async () => Response.json({ publicOrigin: null })

  render(<DomainWidget span={6} editing={false} />)

  expect(await screen.findByText('Public URL not configured.')).toBeTruthy()
  expect(screen.getByText('PUBLIC_ORIGIN')).toBeTruthy()
})

test('domain widget recovers from a failed request on retry', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status: 503 })
  const { container } = render(<DomainWidget span={6} editing={false} />)

  expect(container.querySelector('[data-widget="domain"]')?.getAttribute('aria-busy')).toBe('true')
  expect((await screen.findByRole('status')).textContent).toBe('Couldn’t load the public URL.')
  expect(container.querySelector('[data-widget="domain"]')?.hasAttribute('aria-busy')).toBe(false)

  const publicOrigin = 'http://localhost:3000'
  globalThis.fetch = async () => Response.json({ publicOrigin })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

  expect(await screen.findByText('localhost:3000')).toBeTruthy()
  expect(screen.getByText('Configured public URL')).toBeTruthy()
  expect(screen.queryByText('HTTPS configured')).toBeNull()
})
