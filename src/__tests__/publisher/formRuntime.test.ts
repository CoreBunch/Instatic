import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stampFormPageTokens } from '../../../server/forms/formRuntime'
import { FORM_RUNTIME_JS } from '../../modules/base/forms/formRuntimeJs'

const PAGE_WITH_CMS_FORM = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; worker-src 'none'; style-src 'self'; img-src 'self' data:; connect-src 'self';">
</head>
<body>
<form data-instatic-form-mode="cms" data-instatic-form-id="contact"></form>
</body>
</html>`

describe('stampFormPageTokens', () => {
  it('stamps a page token and page id onto every CMS-native form tag', () => {
    const html = stampFormPageTokens(PAGE_WITH_CMS_FORM, 'page-home')
    expect(html).toContain('data-instatic-page-token=')
    expect(html).toContain('data-instatic-page-id="page-home"')
  })

  it('leaves non-CMS forms untouched', () => {
    const html = stampFormPageTokens(
      PAGE_WITH_CMS_FORM.replace('data-instatic-form-mode="cms"', 'data-instatic-form-mode="custom"'),
      'page-home',
    )
    expect(html).not.toContain('data-instatic-page-token=')
    expect(html).not.toContain('data-instatic-page-id=')
  })

  it('is idempotent', () => {
    const once = stampFormPageTokens(PAGE_WITH_CMS_FORM, 'page-home')
    const twice = stampFormPageTokens(once, 'page-home')
    expect(twice).toBe(once)
    expect(twice.match(/data-instatic-page-token=/g)?.length).toBe(1)
  })
})

describe('form runtime browser behaviour', () => {
  it('prefetches the submit challenge on attach and submits via document-level delegation', async () => {
    document.body.innerHTML = `
      <form data-instatic-form-mode="cms" data-instatic-form-id="contact" data-instatic-page-id="page-home" data-instatic-page-token="page-token">
        <input name="email" value="ai@example.com">
        <button type="submit">Send</button>
        <p data-instatic-form-message="status"></p>
      </form>
    `

    const calls: Array<{ path: string; payload: Record<string, unknown> }> = []
    const originalFetch = globalThis.fetch

    ;(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname
          : input.url
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({ path, payload })

      if (path === '/_instatic/form/challenge') {
        return new Response(JSON.stringify({
          token: 'prefetched-token',
          challenge: 'prefetched-challenge',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ ok: true, rowId: 'row-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      await importRuntimeScript(FORM_RUNTIME_JS)
      await flushRuntime()

      expect(calls.map((call) => call.path)).toEqual(['/_instatic/form/challenge'])
      expect(calls[0].payload.pageId).toBe('page-home')

      const form = document.querySelector('form')
      expect(form).not.toBeNull()
      // No per-form listener — submit is intercepted at document level.
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await waitForCalls(calls, 2)

      expect(calls[0].path).toBe('/_instatic/form/challenge')
      expect(calls[1].path).toBe('/_instatic/form/submit')
      expect(calls[1].payload.pageId).toBe('page-home')
      expect(calls[1].payload.token).toBe('prefetched-token')
      expect(calls[1].payload.challenge).toBe('prefetched-challenge')
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
      document.body.innerHTML = ''
    }
  })

  it('waits out the minimum fill time when the challenge has to be fetched at submit', async () => {
    const harness = installRuntimeHarness({ failFirstChallenge: true })
    try {
      const form = await attachTimedForm('contact-late-challenge')
      expect(harness.challengeResponses.length).toBe(0)

      // The visitor has had the form for longer than the minimum fill time.
      await sleep(MIN_SUBMIT_SECONDS * 1000 + 50)
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => harness.submits.length === 1)

      expect(harness.submits[0].payload.token).toBe('token-1')
      expect(harness.submits[0].time - harness.challengeResponses[0].time)
        .toBeGreaterThanOrEqual(MIN_SUBMIT_SECONDS * 1000)
    } finally {
      harness.restore()
    }
  })

  it('refreshes the challenge before it expires and waits out the fill time on the replacement', async () => {
    const harness = installRuntimeHarness({})
    try {
      const form = await attachTimedForm('contact-refresh')
      await waitFor(() => harness.challengeResponses.length === 1)
      expect(harness.refreshTimers.map((timer) => timer.delay)).toEqual([(CHALLENGE_LIFETIME_SECONDS - 30) * 1000])

      await sleep(MIN_SUBMIT_SECONDS * 1000 + 50)
      harness.refreshTimers[0].run()
      await waitFor(() => harness.challengeResponses.length === 2)
      await sleep(20)

      // Submit just after the replacement has landed: it is younger than the
      // minimum fill time, the visitor is not.
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => harness.submits.length === 1)

      expect(harness.submits[0].payload.token).toBe('token-2')
      expect(harness.submits[0].time - harness.challengeResponses[1].time)
        .toBeGreaterThanOrEqual(MIN_SUBMIT_SECONDS * 1000)
    } finally {
      harness.restore()
    }
  })

  it('measures the challenge lifetime on its own clock, whatever the server clock says', async () => {
    // The server's absolute expiry is already in the past by this browser's
    // clock (visitor clock running fast); the relative lifetime is what counts.
    const harness = installRuntimeHarness({ expiresAt: '2000-01-01T00:00:00.000Z' })
    try {
      const form = await attachTimedForm('contact-skewed-clock')
      await waitFor(() => harness.challengeResponses.length === 1)
      expect(harness.refreshTimers.map((timer) => timer.delay)).toEqual([(CHALLENGE_LIFETIME_SECONDS - 30) * 1000])

      await sleep(MIN_SUBMIT_SECONDS * 1000 + 50)
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => harness.submits.length === 1)

      // The prefetched challenge is still live, so no second one was requested.
      expect(harness.submits[0].payload.token).toBe('token-1')
      expect(harness.submits[0].challengesIssued).toBe(1)
    } finally {
      harness.restore()
    }
  })

  it('posts a submit made before the minimum fill time straight away', async () => {
    const harness = installRuntimeHarness({})
    try {
      const form = await attachTimedForm('contact-too-fast')
      await waitFor(() => harness.challengeResponses.length === 1)
      const submittedAt = Date.now()
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => harness.submits.length === 1)

      // No client-side wait: the server's time trap gets to reject this one.
      expect(harness.submits[0].time - submittedAt).toBeLessThan(MIN_SUBMIT_SECONDS * 1000)
    } finally {
      harness.restore()
    }
  })

  it('shows a success message placed outside a form that holds its error message', async () => {
    document.body.innerHTML = `
      <form data-instatic-form-mode="cms" data-instatic-form-id="contact-split" data-instatic-page-id="page-home" data-instatic-page-token="page-token">
        <input name="email" value="human@example.com">
        <button type="submit">Send</button>
        <p data-instatic-form-message="error" hidden></p>
      </form>
      <p id="outside" data-instatic-form-message="success" data-instatic-form-id="contact-split" hidden>Thanks</p>
    `
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (path === '/_instatic/form/challenge') {
        return Response.json({ token: 't', challenge: 'c', expiresAt: '2099-01-01T00:00:00.000Z' })
      }
      return Response.json({ ok: true })
    }) as unknown as typeof fetch
    try {
      const form = document.querySelector('form') as HTMLFormElement
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => form.getAttribute('data-instatic-form-state') === 'success')

      const outside = document.getElementById('outside') as HTMLElement
      expect(outside.hidden).toBe(false)
      expect(outside.textContent).toBe('Thanks. Your submission was received.')
      expect((form.querySelector('[data-instatic-form-message]') as HTMLElement).hidden).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      document.body.innerHTML = ''
    }
  })

  it('keeps a failure in its own row when the form is repeated in a list', async () => {
    document.body.innerHTML = `
      ${failingMemberForm('disconnect-row', 'first')}
      ${failingMemberForm('disconnect-row', 'second')}
      <p id="outside" data-instatic-form-message="error" data-instatic-form-id="disconnect-row" hidden></p>
    `
    try {
      await submitFailingMemberForm(document.querySelector('form[data-row="second"]'))

      const message = (row: string) =>
        document.querySelector(`form[data-row="${row}"] [data-instatic-form-message]`) as HTMLElement
      const outside = document.getElementById('outside') as HTMLElement
      expect(message('second').hidden).toBe(false)
      expect(message('second').textContent).toBe('Could not disconnect.')
      expect(message('first').hidden).toBe(true)
      expect(message('first').textContent).toBe('')
      expect(outside.hidden).toBe(true)
      expect(outside.textContent).toBe('')
      expect(outside.hasAttribute('data-instatic-default-text')).toBe(false)
    } finally {
      document.body.innerHTML = ''
    }
  })
})

const MIN_SUBMIT_SECONDS = 0.2
const CHALLENGE_LIFETIME_SECONDS = 300

type RuntimeHarness = {
  challengeResponses: Array<{ time: number }>
  submits: Array<{ payload: Record<string, unknown>; time: number; challengesIssued: number }>
  /** Challenge-refresh timers the runtime scheduled, held instead of run. */
  refreshTimers: Array<{ delay: number; run: () => void }>
  restore: () => void
}

/**
 * Stubs the public form endpoints and holds back the runtime's long
 * challenge-refresh timer so a test can fire it on demand. Short timers (the
 * fill-time wait) run for real.
 */
function installRuntimeHarness(options: { failFirstChallenge?: boolean; expiresAt?: string }): RuntimeHarness {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const harness: RuntimeHarness = {
    challengeResponses: [],
    submits: [],
    refreshTimers: [],
    restore: () => {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      document.body.innerHTML = ''
    },
  }
  let challengeRequests = 0

  globalThis.setTimeout = ((handler: () => void, delay = 0) => {
    if (delay < 10_000) return originalSetTimeout(handler, delay)
    harness.refreshTimers.push({ delay, run: handler })
    return originalSetTimeout(() => {}, 0)
  }) as typeof setTimeout

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (path === '/_instatic/form/challenge') {
      challengeRequests += 1
      if (options.failFirstChallenge && challengeRequests === 1) throw new TypeError('Failed to fetch')
      harness.challengeResponses.push({ time: Date.now() })
      const issued = harness.challengeResponses.length
      return Response.json({
        token: `token-${issued}`,
        challenge: `challenge-${issued}`,
        expiresAt: options.expiresAt ?? new Date(Date.now() + CHALLENGE_LIFETIME_SECONDS * 1000).toISOString(),
        expiresInSeconds: CHALLENGE_LIFETIME_SECONDS,
        minSubmitSeconds: MIN_SUBMIT_SECONDS,
      })
    }
    harness.submits.push({
      payload: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      time: Date.now(),
      challengesIssued: harness.challengeResponses.length,
    })
    return Response.json({ ok: true })
  }) as typeof fetch

  return harness
}

/** A member form that fails at its endpoint, with an error message inside it. */
function failingMemberForm(formId: string, row: string): string {
  return `
    <form data-row="${row}" data-instatic-form-mode="member" data-instatic-form-id="${formId}" action="/_instatic/members/apps/disconnect">
      <button type="submit">Disconnect</button>
      <p data-instatic-form-message="error" hidden></p>
    </form>
  `
}

/** Submits a member form whose endpoint answers with an error, and waits for the error state. */
async function submitFailingMemberForm(form: Element | null): Promise<void> {
  if (!form) throw new Error('form fixture missing')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json(
    { ok: false, error: { message: 'Could not disconnect.' } },
    { status: 400 },
  )) as unknown as typeof fetch
  try {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => form.getAttribute('data-instatic-form-state') === 'error')
  } finally {
    globalThis.fetch = originalFetch
  }
}

/** Adds a CMS form and attaches the already-loaded runtime to it via focus. */
async function attachTimedForm(formId: string): Promise<HTMLFormElement> {
  document.body.innerHTML = `
    <form data-instatic-form-mode="cms" data-instatic-form-id="${formId}" data-instatic-page-id="page-home" data-instatic-page-token="page-token">
      <input name="email" value="human@example.com">
      <button type="submit">Send</button>
    </form>
  `
  const form = document.querySelector('form')
  if (!form) throw new Error('form fixture missing')
  form.querySelector('input')?.dispatchEvent(new Event('focusin', { bubbles: true }))
  await flushRuntime()
  return form
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > 3_000) throw new Error('condition not met within 3 s')
    await sleep(10)
  }
}

async function flushRuntime(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

let runtimeImportCounter = 0

async function importRuntimeScript(source: string): Promise<void> {
  runtimeImportCounter += 1
  const dir = join(process.cwd(), '.tmp', 'form-runtime-tests')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `runtime-${runtimeImportCounter}.mjs`)
  await writeFile(path, source, 'utf8')
  await import(`${pathToFileURL(path).href}?v=${runtimeImportCounter}`)
}

async function waitForCalls(calls: unknown[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (calls.length >= count) return
    await flushRuntime()
  }
}
