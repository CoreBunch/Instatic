import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

mock.module('../../../ai/api', () => ({
  listMcpConnectors: async () => [],
  createMcpConnector: async () => ({
    connector: {
      id: 'c1', label: 'L', type: 'local', authMode: 'bearer',
      capabilities: ['ai.chat'], createdAt: '', lastUsedAt: null, revoked: false,
    },
    token: 'imcp_test',
  }),
  revokeMcpConnector: async () => {},
}))

const { McpTab } = await import('./McpTab')

afterEach(() => cleanup())

describe('McpTab', () => {
  it('renders the empty state and an add action', async () => {
    render(<McpTab />)
    expect(await screen.findByRole('button', { name: /add connector/i })).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText(/No connectors yet/i)).toBeTruthy()
    })
  })
})
