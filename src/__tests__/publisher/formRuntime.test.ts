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
})

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
