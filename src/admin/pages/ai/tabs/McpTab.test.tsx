import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('../../../ai/api', () => ({
  getMcpConnectionOverview: async () => ({
    connections: [],
    endpoint: 'http://localhost/_instatic/mcp',
    remoteAccess: 'local-only',
  }),
  createMcpAccessToken: async () => ({
    connection: {
      id: 'c1', label: 'L', authMode: 'bearer',
      capabilities: ['ai.chat'], createdAt: '', lastUsedAt: null, revoked: false,
      expiresAt: null,
    },
    accessToken: 'imcp_pat_test',
  }),
  revokeMcpConnection: async () => {},
}))

const { McpTab } = await import('./McpTab')

afterEach(() => cleanup())

describe('McpTab', () => {
  it('separates hosted OAuth setup from personal access tokens', async () => {
    render(<McpTab />)

    expect(await screen.findByRole('heading', { name: /connect a remote client/i })).toBeTruthy()
    expect(screen.getByText(/Available on this device only/i)).toBeTruthy()
    expect(screen.getByText(/Hosted clients connect from the cloud/i)).toBeTruthy()
    expect(screen.getByText(/Leave OAuth Client ID and Secret empty/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Personal token Local and CLI clients/i }))

    expect(screen.getByRole('heading', { name: /create a personal token/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /create access token/i })).toBeTruthy()
  })
})
