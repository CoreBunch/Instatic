/**
 * Where the collab WebSocket dials.
 *
 * The dev branch exists because Vite (running inside Bun) cannot forward
 * WebSocket upgrades; the socket skips the proxy and dials the CMS port.
 * The invariant that matters most is that only the PORT is swapped — the
 * session cookie is `SameSite=Lax`, so rewriting `127.0.0.1` to `localhost`
 * (or the reverse) would make the handshake cross-site, drop the cookie, and
 * 401 into an endless reconnect.
 */
import { describe, expect, it } from 'bun:test'
import { collabSocketUrl } from '@site/collab/socketUrl'

const PATH = '/admin/api/cms/site-socket'

describe('collabSocketUrl', () => {
  describe('production (same origin)', () => {
    it('uses the page host verbatim', () => {
      const url = collabSocketUrl(
        { protocol: 'https:', host: 'cms.example.com', hostname: 'cms.example.com' },
        null,
      )
      expect(url).toBe(`wss://cms.example.com${PATH}`)
    })

    it('keeps a non-default port that is part of the origin', () => {
      const url = collabSocketUrl(
        { protocol: 'http:', host: 'box.internal:8080', hostname: 'box.internal' },
        null,
      )
      expect(url).toBe(`ws://box.internal:8080${PATH}`)
    })

    it('downgrades to ws on a plain-http origin', () => {
      const url = collabSocketUrl(
        { protocol: 'http:', host: 'cms.example.com', hostname: 'cms.example.com' },
        null,
      )
      expect(url).toBe(`ws://cms.example.com${PATH}`)
    })
  })

  describe('vite dev (CMS port dialled directly)', () => {
    it('swaps only the port, preserving a localhost page', () => {
      const url = collabSocketUrl(
        { protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' },
        '3001',
      )
      expect(url).toBe(`ws://localhost:3001${PATH}`)
    })

    // `bun run dev` serves Vite on 127.0.0.1; rewriting to a `localhost`
    // literal here would make the handshake cross-site and drop the cookie.
    it('swaps only the port, preserving a 127.0.0.1 page', () => {
      const url = collabSocketUrl(
        { protocol: 'http:', host: '127.0.0.1:5173', hostname: '127.0.0.1' },
        '3001',
      )
      expect(url).toBe(`ws://127.0.0.1:3001${PATH}`)
    })

    it('honours a non-default CMS port (e2e harness)', () => {
      const url = collabSocketUrl(
        { protocol: 'http:', host: '127.0.0.1:5174', hostname: '127.0.0.1' },
        '3002',
      )
      expect(url).toBe(`ws://127.0.0.1:3002${PATH}`)
    })

    it('never carries the Vite port through', () => {
      const url = collabSocketUrl(
        { protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' },
        '3001',
      )
      expect(url).not.toContain('5173')
    })
  })
})
