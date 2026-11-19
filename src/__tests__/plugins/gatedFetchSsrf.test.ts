import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Value } from '@sinclair/typebox/value'
import {
  PluginFetchTimeoutError,
  guardedFetch,
  performGatedFetch,
  isBlockedAddress,
} from '../../../server/plugins/host/network'
import { DEFAULT_PLUGIN_FETCH_TIMEOUT_MS } from '../../../server/plugins/quickjs/limits'
import { NetworkFetchInitSchema } from '../../../server/plugins/protocol/schemas/network'
import type { HostPluginRecord } from '../../../server/plugins/host/types'

/**
 * SSRF hardening for the gated plugin fetch (ISS-004, ISS-005, ISS-010, ISS-011).
 *
 * `performGatedFetch` is the single kernel-of-correctness for plugin outbound
 * network access. It must:
 *  - block any target (initial OR redirect) that resolves to a private,
 *    loopback, link-local, CGNAT or unique-local address — even when the
 *    hostname is allowlisted (DNS rebinding / cloud-metadata),
 *  - follow redirects manually and re-apply the allowlist + IP guard to every
 *    hop (no transparent redirect following),
 *  - cap the redirect chain.
 */

function makeEntry(allowlist: string[]): HostPluginRecord {
  return {
    manifest: { id: 'test.plugin', networkAllowedHosts: allowlist },
    inflightFetches: new Map(),
  } as unknown as HostPluginRecord
}

const PUBLIC_IP = '93.184.216.34'

/**
 * A fetch stub driven by a scripted sequence of responses keyed by the LOGICAL
 * (hostname) URL. The guard pins the connection to a validated IP, so the real
 * call arrives at `https://<ip>/path` with the hostname in the `Host` header;
 * we reconstruct the hostname URL from that header so scripts stay readable.
 */
function scriptedFetch(script: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const called = new URL(typeof input === 'string' ? input : input.toString())
    const hostHeader = (init?.headers as Record<string, string> | undefined)?.Host
    const logical = `${called.protocol}//${hostHeader ?? called.host}${called.pathname}${called.search}`
    const entry = script[logical]
    if (!entry) throw new Error(`unexpected fetch to ${logical} (pinned ${called.host})`)
    return typeof entry === 'function' ? entry() : entry
  }) as unknown as typeof fetch
}

function resolver(map: Record<string, string[]>): (host: string) => Promise<string[]> {
  return async (host: string) => map[host] ?? [PUBLIC_IP]
}

describe('isBlockedAddress', () => {
  test('blocks loopback, private, link-local, CGNAT, ULA and mapped forms', () => {
    for (const ip of [
      '127.0.0.1', '127.5.5.5', '10.0.0.1', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
  })
  test('allows ordinary public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1::1']) {
      expect(isBlockedAddress(ip)).toBe(false)
    }
  })
  // GHSA-99x9: non-canonical spellings of loopback. GHSA-ffj5: IPv6 transition
  // prefixes (NAT64 / 6to4 / Teredo) that embed an internal IPv4. The prior
  // string / prefix matcher missed all of these; parsing to a canonical range
  // catches them.
  test('blocks non-canonical loopback and IPv6 transition addresses', () => {
    for (const ip of [
      '::0:1', '0::1', '0:0::1', '::00:1',
      '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
  })
})

describe('performGatedFetch — SSRF guards', () => {
  test('fetches an allowlisted public host', async () => {
    const res = await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/data',
      {},
      {
        fetchImpl: scriptedFetch({ 'https://api.example.com/data': new Response('OK', { status: 200 }) }),
        resolveHostAddresses: resolver({ 'api.example.com': [PUBLIC_IP] }),
      },
    )
    expect(res.body).toBe('OK')
    expect(res.status).toBe(200)
  })

  // GHSA-c76p / GHSA-r4rj: the check resolved the host, but the connect
  // re-resolved it, so a rebinding DNS could swing the socket to an internal IP
  // between the two. The guard now pins the connection to the checked IP.
  test('pins the connection to the validated IP, defeating DNS rebinding', async () => {
    let fetchedUrl = ''
    let fetchedHost = ''
    let fetchedSni = ''
    const fetchImpl = (async (input: string | URL, init?: RequestInit & { tls?: { serverName: string } }) => {
      fetchedUrl = String(input)
      fetchedHost = (init?.headers as Record<string, string> | undefined)?.Host ?? ''
      fetchedSni = init?.tls?.serverName ?? ''
      return new Response('OK', { status: 200 })
    }) as unknown as typeof fetch

    // A rebinding resolver hands a metadata IP on any SECOND lookup. With
    // pinning there is no second lookup, so the first (public) result is used.
    let calls = 0
    const rebinding = async () => (++calls === 1 ? [PUBLIC_IP] : ['169.254.169.254'])

    const res = await performGatedFetch(
      makeEntry(['rebind.example.com']),
      'https://rebind.example.com/x',
      {},
      { fetchImpl, resolveHostAddresses: rebinding },
    )

    expect(res.status).toBe(200)
    expect(fetchedUrl).toBe(`https://${PUBLIC_IP}/x`) // pinned to the checked IP
    expect(fetchedHost).toBe('rebind.example.com') // Host preserved for vhosting
    expect(fetchedSni).toBe('rebind.example.com') // TLS SNI + cert identity preserved
    expect(calls).toBe(1) // resolved exactly once, no re-resolution to rebind
  })

  test('rejects an allowlisted host that resolves to a private IP (DNS rebinding)', async () => {
    await expect(
      performGatedFetch(
        makeEntry(['internal.example.com']),
        'https://internal.example.com/',
        {},
        {
          fetchImpl: scriptedFetch({}),
          resolveHostAddresses: resolver({ 'internal.example.com': ['10.0.0.5'] }),
        },
      ),
    ).rejects.toThrow(/blocked|private|resolves/i)
  })

  test('rejects a redirect to a non-allowlisted host', async () => {
    await expect(
      performGatedFetch(
        makeEntry(['api.example.com']),
        'https://api.example.com/start',
        {},
        {
          fetchImpl: scriptedFetch({
            'https://api.example.com/start': new Response(null, {
              status: 302,
              headers: { location: 'https://evil.example.org/' },
            }),
          }),
          resolveHostAddresses: resolver({ 'api.example.com': [PUBLIC_IP] }),
        },
      ),
    ).rejects.toThrow(/allowlist/i)
  })

  test('rejects a redirect to an allowlisted host that resolves to metadata IP', async () => {
    await expect(
      performGatedFetch(
        makeEntry(['api.example.com', 'metadata.example.com']),
        'https://api.example.com/start',
        {},
        {
          fetchImpl: scriptedFetch({
            'https://api.example.com/start': new Response(null, {
              status: 302,
              headers: { location: 'https://metadata.example.com/latest/meta-data/' },
            }),
          }),
          resolveHostAddresses: resolver({
            'api.example.com': [PUBLIC_IP],
            'metadata.example.com': ['169.254.169.254'],
          }),
        },
      ),
    ).rejects.toThrow(/blocked|private|resolves/i)
  })

  test('follows a redirect to an allowlisted public host', async () => {
    const res = await performGatedFetch(
      makeEntry(['a.example.com', 'b.example.com']),
      'https://a.example.com/start',
      {},
      {
        fetchImpl: scriptedFetch({
          'https://a.example.com/start': new Response(null, {
            status: 302,
            headers: { location: 'https://b.example.com/final' },
          }),
          'https://b.example.com/final': new Response('LANDED', { status: 200 }),
        }),
        resolveHostAddresses: resolver({ 'a.example.com': [PUBLIC_IP], 'b.example.com': [PUBLIC_IP] }),
      },
    )
    expect(res.body).toBe('LANDED')
  })

  test('caps the redirect chain', async () => {
    // Every hop redirects to the next within the same allowlisted host.
    const fetchImpl = (async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const n = Number(new URL(url).searchParams.get('n') ?? '0')
      return new Response(null, { status: 302, headers: { location: `https://loop.example.com/?n=${n + 1}` } })
    }) as unknown as typeof fetch
    await expect(
      performGatedFetch(
        makeEntry(['loop.example.com']),
        'https://loop.example.com/?n=0',
        {},
        { fetchImpl, resolveHostAddresses: resolver({ 'loop.example.com': [PUBLIC_IP] }) },
      ),
    ).rejects.toThrow(/redirect/i)
  })
})

/** A fetch stub that records every call's logical URL and request headers. */
function recordingFetch(script: Record<string, Response>): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; method: string; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const called = new URL(typeof input === 'string' ? input : input.toString())
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) }
    const logical = `${called.protocol}//${headers.Host ?? called.host}${called.pathname}${called.search}`
    calls.push({ url: logical, method: init?.method ?? 'GET', headers })
    const entry = script[logical]
    if (!entry) throw new Error(`unexpected fetch to ${logical}`)
    return entry
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe("performGatedFetch — redirect: 'manual' and 'error'", () => {
  test('manual returns the redirect itself and never contacts the target', async () => {
    // The target is neither allowlisted nor public: it must not even be resolved.
    const resolved: string[] = []
    const { fetchImpl, calls } = recordingFetch({
      'https://api.example.com/asset': new Response(null, {
        status: 302,
        headers: { location: 'https://signed.internal.example/blob?sig=abc' },
      }),
    })
    const res = await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/asset',
      { redirect: 'manual', headers: { Authorization: 'Bearer secret' } },
      {
        fetchImpl,
        resolveHostAddresses: async (host) => {
          resolved.push(host)
          return host === 'api.example.com' ? [PUBLIC_IP] : ['10.0.0.5']
        },
      },
    )
    expect(res.status).toBe(302)
    expect(res.ok).toBe(false)
    expect(res.redirected).toBe(false)
    expect(res.headers.location).toBe('https://signed.internal.example/blob?sig=abc')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.example.com/asset')
    expect(resolved).toEqual(['api.example.com'])
  })

  test('the same redirect is still refused when followed', async () => {
    const { fetchImpl } = recordingFetch({
      'https://api.example.com/asset': new Response(null, {
        status: 302,
        headers: { location: 'https://signed.internal.example/blob' },
      }),
    })
    await expect(
      performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/asset', {}, {
        fetchImpl,
        resolveHostAddresses: resolver({}),
      }),
    ).rejects.toThrow(/allowlist/)
  })

  test('manual still gates the first hop: allowlist and blocked addresses', async () => {
    const { fetchImpl, calls } = recordingFetch({})
    await expect(
      performGatedFetch(makeEntry(['api.example.com']), 'https://other.example.com/x', { redirect: 'manual' }, {
        fetchImpl,
        resolveHostAddresses: resolver({}),
      }),
    ).rejects.toThrow(/allowlist/)
    await expect(
      performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/x', { redirect: 'manual' }, {
        fetchImpl,
        resolveHostAddresses: resolver({ 'api.example.com': ['169.254.169.254'] }),
      }),
    ).rejects.toThrow(/blocked address/)
    expect(calls).toHaveLength(0)
  })

  test('manual passes a non-redirect response through unchanged', async () => {
    const { fetchImpl } = recordingFetch({ 'https://api.example.com/data': new Response('OK', { status: 200 }) })
    const res = await performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/data', { redirect: 'manual' }, {
      fetchImpl,
      resolveHostAddresses: resolver({}),
    })
    expect(res.status).toBe(200)
    expect(res.body).toBe('OK')
    expect(res.redirected).toBe(false)
  })

  test('error rejects on a redirect and makes one request', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://api.example.com/moved': new Response(null, {
        status: 301,
        headers: { location: 'https://api.example.com/new' },
      }),
    })
    await expect(
      performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/moved', { redirect: 'error' }, {
        fetchImpl,
        resolveHostAddresses: resolver({}),
      }),
    ).rejects.toThrow(/redirected/)
    expect(calls).toHaveLength(1)
  })

  test('error rejects on a redirect status with no Location', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { fetchImpl } = recordingFetch({ 'https://api.example.com/x': new Response(null, { status }) })
      await expect(
        performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/x', { redirect: 'error' }, {
          fetchImpl,
          resolveHostAddresses: resolver({}),
        }),
      ).rejects.toThrow(/redirected/)
    }
  })

  test('follow returns a redirect status with no Location as the response', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://api.example.com/x': new Response('no location here', { status: 302 }),
    })
    const res = await performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/x', {}, {
      fetchImpl,
      resolveHostAddresses: resolver({}),
    })
    expect(res.status).toBe(302)
    expect(res.body).toBe('no location here')
    expect(res.redirected).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('manual drops the redirect body instead of buffering it', async () => {
    let pulled = 0
    let cancelled = false
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const { fetchImpl } = recordingFetch({
      'https://api.example.com/asset': new Response(big, {
        status: 302,
        headers: { location: 'https://signed.example.net/blob' },
      }),
    })
    const res = await performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/asset', { redirect: 'manual' }, {
      fetchImpl,
      resolveHostAddresses: resolver({}),
    })
    expect(res.status).toBe(302)
    expect(res.body).toBe('')
    expect(res.headers.location).toBe('https://signed.example.net/blob')
    expect(cancelled).toBe(true)
    // An endless stream: reading it to the end would never return.
    expect(pulled).toBeLessThan(4)
  })

  test('manual returns a redirect status with no Location too', async () => {
    const { fetchImpl } = recordingFetch({ 'https://api.example.com/x': new Response('body', { status: 307 }) })
    const res = await performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/x', { redirect: 'manual' }, {
      fetchImpl,
      resolveHostAddresses: resolver({}),
    })
    expect(res.status).toBe(307)
    expect(res.headers.location).toBeUndefined()
    expect(res.body).toBe('')
  })

  test('several Location headers arrive joined', async () => {
    const headers = new Headers()
    headers.append('location', 'https://one.example.net/a')
    headers.append('location', 'https://two.example.net/b')
    const { fetchImpl } = recordingFetch({ 'https://api.example.com/x': new Response(null, { status: 302, headers }) })
    const res = await performGatedFetch(makeEntry(['api.example.com']), 'https://api.example.com/x', { redirect: 'manual' }, {
      fetchImpl,
      resolveHostAddresses: resolver({}),
    })
    expect(res.headers.location).toBe('https://one.example.net/a, https://two.example.net/b')
  })

  test('the RPC schema accepts the three modes and refuses anything else', () => {
    for (const redirect of ['follow', 'manual', 'error']) {
      expect(Value.Check(NetworkFetchInitSchema, { redirect })).toBe(true)
    }
    for (const redirect of ['junk', 'MANUAL', '', 1, null, true]) {
      expect(Value.Check(NetworkFetchInitSchema, { redirect })).toBe(false)
    }
  })

  test('a followed redirect reports redirected: true', async () => {
    const { fetchImpl } = recordingFetch({
      'https://a.example.com/start': new Response(null, { status: 302, headers: { location: '/final' } }),
      'https://a.example.com/final': new Response('LANDED', { status: 200 }),
    })
    const res = await performGatedFetch(makeEntry(['a.example.com']), 'https://a.example.com/start', {}, {
      fetchImpl,
      resolveHostAddresses: resolver({}),
    })
    expect(res.redirected).toBe(true)
    expect(res.body).toBe('LANDED')
  })
})

describe('performGatedFetch — credentials stay with their origin', () => {
  const CREDENTIALS = {
    Authorization: 'Bearer secret',
    Cookie: 'sid=1',
    'Proxy-Authorization': 'Basic abc',
    'X-Trace': 'keep-me',
  }

  test('a redirect to another allowlisted host does not receive Authorization or Cookie', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://a.example.com/start': new Response(null, {
        status: 302,
        headers: { location: 'https://b.example.com/final' },
      }),
      'https://b.example.com/final': new Response('LANDED', { status: 200 }),
    })
    await performGatedFetch(
      makeEntry(['a.example.com', 'b.example.com']),
      'https://a.example.com/start',
      { headers: CREDENTIALS },
      { fetchImpl, resolveHostAddresses: resolver({}) },
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].headers.Authorization).toBe('Bearer secret')
    const second = Object.keys(calls[1].headers).map((k) => k.toLowerCase())
    expect(second).not.toContain('authorization')
    expect(second).not.toContain('cookie')
    expect(second).not.toContain('proxy-authorization')
    expect(calls[1].headers['X-Trace']).toBe('keep-me')
  })

  test('a same-origin redirect keeps them', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://a.example.com/start': new Response(null, { status: 307, headers: { location: '/final' } }),
      'https://a.example.com/final': new Response('LANDED', { status: 200 }),
    })
    await performGatedFetch(makeEntry(['a.example.com']), 'https://a.example.com/start', { headers: CREDENTIALS }, {
      fetchImpl,
      resolveHostAddresses: resolver({}),
    })
    expect(calls[1].headers.Authorization).toBe('Bearer secret')
    expect(calls[1].headers.Cookie).toBe('sid=1')
  })

  test('a hop back to the first origin does not get them again', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://a.example.com/start': new Response(null, { status: 302, headers: { location: 'https://b.example.com/mid' } }),
      'https://b.example.com/mid': new Response(null, { status: 302, headers: { location: 'https://a.example.com/final' } }),
      'https://a.example.com/final': new Response('LANDED', { status: 200 }),
    })
    await performGatedFetch(
      makeEntry(['a.example.com', 'b.example.com']),
      'https://a.example.com/start',
      { headers: CREDENTIALS },
      { fetchImpl, resolveHostAddresses: resolver({}) },
    )
    expect(calls).toHaveLength(3)
    expect(Object.keys(calls[2].headers).map((k) => k.toLowerCase())).not.toContain('authorization')
  })

  test('a scheme change is a different origin', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://a.example.com/start': new Response(null, { status: 302, headers: { location: 'http://a.example.com/final' } }),
      'http://a.example.com/final': new Response('LANDED', { status: 200 }),
    })
    await performGatedFetch(makeEntry(['a.example.com']), 'https://a.example.com/start', { headers: CREDENTIALS }, {
      fetchImpl,
      resolveHostAddresses: resolver({}),
    })
    expect(calls).toHaveLength(2)
    const second = Object.keys(calls[1].headers).map((k) => k.toLowerCase())
    expect(second).not.toContain('authorization')
    expect(second).not.toContain('cookie')
  })

  // A manifest entry cannot carry a port, and the allowlist compares the full
  // host, so a plugin's redirect to another port never gets as far as headers.
  test('a plugin redirect to another port is refused by the allowlist', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://a.example.com/start': new Response(null, { status: 302, headers: { location: 'https://a.example.com:8443/final' } }),
    })
    await expect(
      performGatedFetch(makeEntry(['a.example.com']), 'https://a.example.com/start', { headers: CREDENTIALS }, {
        fetchImpl,
        resolveHostAddresses: resolver({}),
      }),
    ).rejects.toThrow(/allowlist/)
    expect(calls).toHaveLength(1)
  })

  // Callers with no allowlist (media) can cross ports; the port is part of the origin.
  test('guardedFetch drops credentials on a port change', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://a.example.com/start': new Response(null, { status: 302, headers: { location: 'https://a.example.com:8443/final' } }),
      'https://a.example.com:8443/final': new Response('LANDED', { status: 200 }),
    })
    const res = await guardedFetch('https://a.example.com/start', { headers: CREDENTIALS }, {
      fetchImpl,
      resolveHost: resolver({}),
    })
    expect(await res.text()).toBe('LANDED')
    expect(Object.keys(calls[1].headers).map((k) => k.toLowerCase())).not.toContain('authorization')
    expect(calls[1].headers['X-Trace']).toBe('keep-me')
  })

  test('header names are matched case-insensitively', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://a.example.com/start': new Response(null, { status: 302, headers: { location: 'https://b.example.com/final' } }),
      'https://b.example.com/final': new Response('LANDED', { status: 200 }),
    })
    await performGatedFetch(
      makeEntry(['a.example.com', 'b.example.com']),
      'https://a.example.com/start',
      { headers: { AUTHORIZATION: 'Bearer secret', COOKIE: 'sid=1', 'PROXY-AUTHORIZATION': 'Basic abc', 'X-Api-Key': 'custom' } },
      { fetchImpl, resolveHostAddresses: resolver({}) },
    )
    const second = Object.keys(calls[1].headers).map((k) => k.toLowerCase())
    expect(second).not.toContain('authorization')
    expect(second).not.toContain('cookie')
    expect(second).not.toContain('proxy-authorization')
    // Only the three standard credential headers go; a custom one still travels.
    expect(calls[1].headers['X-Api-Key']).toBe('custom')
  })

  test('a 307 keeps its method and body across origins', async () => {
    const { fetchImpl, calls } = recordingFetch({
      'https://a.example.com/start': new Response(null, { status: 307, headers: { location: 'https://b.example.com/final' } }),
      'https://b.example.com/final': new Response('LANDED', { status: 200 }),
    })
    await performGatedFetch(
      makeEntry(['a.example.com', 'b.example.com']),
      'https://a.example.com/start',
      { method: 'POST', body: 'payload', headers: { 'Content-Type': 'text/plain', Authorization: 'Bearer secret' } },
      { fetchImpl, resolveHostAddresses: resolver({}) },
    )
    expect(calls[1].method).toBe('POST')
    expect(calls[1].headers['Content-Type']).toBe('text/plain')
    expect(calls[1].headers.Authorization).toBeUndefined()
  })
})

describe('network.ts source invariant', () => {
  test('uses manual redirect handling (never transparent following)', () => {
    const src = readFileSync(new URL('../../../server/plugins/host/network.ts', import.meta.url), 'utf8')
    expect(src).toContain("redirect: 'manual'")
  })
})

describe('performGatedFetch — request timeout', () => {
  test('times out a request that never answers and cancels it upstream', async () => {
    let upstreamAborted = false
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          upstreamAborted = true
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })) as unknown as typeof fetch
    const entry = makeEntry(['api.example.com'])
    const failure = await performGatedFetch(
      entry,
      'https://api.example.com/slow',
      { timeoutMs: 30, abortId: 'a1_x' },
      { fetchImpl: hanging, resolveHostAddresses: resolver({}) },
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(PluginFetchTimeoutError)
    expect((failure as Error).message).toBe('Plugin "test.plugin" fetch timed out after 30ms')
    expect(upstreamAborted).toBe(true)
    expect(entry.inflightFetches.size).toBe(0)
  })

  test('times out a response whose body stalls, and cancels the body', async () => {
    let bodyCancelled = false
    const stalled = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('partial')) },
        cancel() { bodyCancelled = true },
      }),
      { status: 200 },
    )
    await expect(
      performGatedFetch(
        makeEntry(['api.example.com']),
        'https://api.example.com/stall',
        { timeoutMs: 30 },
        {
          fetchImpl: scriptedFetch({ 'https://api.example.com/stall': stalled }),
          resolveHostAddresses: resolver({}),
        },
      ),
    ).rejects.toThrow('fetch timed out after 30ms')
    expect(bodyCancelled).toBe(true)
  })

  test('a request that answers in time is not affected by the timeout', async () => {
    const res = await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/data',
      { timeoutMs: 5_000 },
      {
        fetchImpl: scriptedFetch({ 'https://api.example.com/data': new Response('OK', { status: 200 }) }),
        resolveHostAddresses: resolver({}),
      },
    )
    expect(res.body).toBe('OK')
  })

  test('times out a DNS lookup that stalls', async () => {
    let connected = false
    const failure = await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/data',
      { timeoutMs: 30 },
      {
        fetchImpl: (async () => { connected = true; return new Response('late') }) as unknown as typeof fetch,
        resolveHostAddresses: () => new Promise<string[]>(() => { /* never answers */ }),
      },
    ).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(PluginFetchTimeoutError)
    expect((failure as PluginFetchTimeoutError).code).toBe('fetch_timeout')
    expect(connected).toBe(false)
  })

  test('reports a refusal as the refusal even when the timer has fired', async () => {
    // The resolver answers, late, with a blocked address. The timer fires
    // while it blocks the thread, so both have happened by the time the
    // request fails: the refusal is the truth.
    const slowBlocked = async (): Promise<string[]> => {
      const until = Date.now() + 60
      while (Date.now() < until) { /* hold the thread past the 20 ms timeout */ }
      return ['127.0.0.1']
    }
    const failure = await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/data',
      { timeoutMs: 20 },
      { fetchImpl: scriptedFetch({}), resolveHostAddresses: slowBlocked },
    ).catch((err: unknown) => err)
    expect(failure).not.toBeInstanceOf(PluginFetchTimeoutError)
    expect((failure as Error).message).toMatch(/blocked|private|not allowed|internal/i)
  })

  test('defaults the timeout to 15 seconds', () => {
    expect(DEFAULT_PLUGIN_FETCH_TIMEOUT_MS).toBe(15_000)
  })
})
