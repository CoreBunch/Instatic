import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'

describe('AI credential handler', () => {
  let harness: CapabilityTestHarness
  let originalFetch: typeof globalThis.fetch
  let originalWarn: typeof console.warn
  let originalError: typeof console.error
  let originalNodeEnv: string | undefined
  let originalSecretKey: string | undefined

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    originalWarn = console.warn
    originalError = console.error
    originalNodeEnv = process.env.NODE_ENV
    originalSecretKey = process.env.INSTATIC_SECRET_KEY
    __resetMasterKeyCacheForTesting()
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url === 'https://api.openai.com/v1/models') {
        return new Response(JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4.1' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return originalFetch(input, init)
    }

    harness = await createCapabilityTestHarness()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    console.error = originalError
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    if (originalSecretKey === undefined) {
      delete process.env.INSTATIC_SECRET_KEY
    } else {
      process.env.INSTATIC_SECRET_KEY = originalSecretKey
    }
    __resetMasterKeyCacheForTesting()
    await harness.cleanup()
  })

  it('creates the credential when auto-default seeding fails', async () => {
    const cookie = await harness.setupOwner()
    await harness.db.unsafe(`
      create trigger fail_ai_default_insert
      before insert on ai_defaults
      begin
        select raise(abort, 'default write failed');
      end;
    `)

    console.warn = () => {}
    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai',
        authMode: 'apiKey',
        displayLabel: 'OpenAI',
        apiKey: 'sk-proj-test',
      },
    })
    console.warn = originalWarn

    expect(res.status).toBe(201)
    const body = await readJson<{ credential: { providerId: string; displayLabel: string } }>(res)
    expect(body.credential).toMatchObject({
      providerId: 'openai',
      displayLabel: 'OpenAI',
    })

    const { rows } = await harness.db<{ count: number }>`
      select count(*) as count
      from ai_provider_credentials
      where provider_id = 'openai'
    `
    expect(rows[0]?.count).toBe(1)
  })

  it('does not auto-default an offline Ollama credential from fallback models', async () => {
    const cookie = await harness.setupOwner()
    const warnings: string[] = []
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '))
    }
    console.error = () => {}
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url === 'http://127.0.0.1:1/api/tags') {
        throw new Error('ollama offline')
      }
      return originalFetch(input)
    }

    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'ollama',
        authMode: 'baseUrl',
        displayLabel: 'Local Ollama',
        baseUrl: 'http://127.0.0.1:1',
      },
    })

    expect(res.status).toBe(201)
    const { rows } = await harness.db<{ count: number }>`
      select count(*) as count
      from ai_defaults
    `
    expect(rows[0]?.count).toBe(0)
    expect(warnings.join('\n')).toContain('auto-default skipped')
  })

  it('redacts API keys from auto-default model lookup warnings', async () => {
    const cookie = await harness.setupOwner()
    const apiKey = 'sk-proj-redaction-test'
    const warnings: string[] = []
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '))
    }
    globalThis.fetch = async () => {
      throw new Error(`model lookup failed with ${apiKey}`)
    }

    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai',
        authMode: 'apiKey',
        displayLabel: 'OpenAI',
        apiKey,
      },
    })

    expect(res.status).toBe(201)
    expect(warnings.join('\n')).not.toContain(apiKey)
    expect(warnings.join('\n')).toContain('[redacted]')
  })

  it('surfaces a clear production error when the credential encryption key is missing', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.INSTATIC_SECRET_KEY
    __resetMasterKeyCacheForTesting()

    const cookie = await harness.setupOwner()

    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai',
        authMode: 'apiKey',
        displayLabel: 'OpenAI',
        apiKey: 'sk-proj-test',
      },
    })

    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('INSTATIC_SECRET_KEY')
    expect(body.error).not.toContain('sk-proj-test')
  })

  it('redacts API keys from credential test failures', async () => {
    const cookie = await harness.setupOwner()
    const apiKey = 'sk-proj-test-endpoint-redaction'
    const createRes = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai',
        authMode: 'apiKey',
        displayLabel: 'OpenAI',
        apiKey,
      },
    })
    const createBody = await readJson<{ credential: { id: string } }>(createRes)
    globalThis.fetch = async () => {
      throw new Error(`provider echoed ${apiKey}`)
    }

    const testRes = await harness.ai(`/admin/api/ai/credentials/${createBody.credential.id}/test`, {
      method: 'POST',
      cookie,
    })

    expect(testRes.status).toBe(200)
    const body = await readJson<{ ok: boolean; error: string }>(testRes)
    expect(body.ok).toBe(false)
    expect(body.error).not.toContain(apiKey)
    expect(body.error).toContain('[redacted]')
  })

  it('reports a failed credential test when the provider returns no live models', async () => {
    const cookie = await harness.setupOwner()
    console.warn = () => {}
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url === 'https://bad.example/v1/models') {
        return new Response(JSON.stringify({ error: 'bad key' }), { status: 401 })
      }
      return originalFetch(input)
    }

    const createRes = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai-compatible',
        authMode: 'baseUrl',
        displayLabel: 'Custom',
        baseUrl: 'https://bad.example/v1',
        apiKey: 'sk-custom-test',
      },
    })
    expect(createRes.status).toBe(201)
    const createBody = await readJson<{ credential: { id: string } }>(createRes)

    const testRes = await harness.ai(`/admin/api/ai/credentials/${createBody.credential.id}/test`, {
      method: 'POST',
      cookie,
    })

    expect(testRes.status).toBe(200)
    const body = await readJson<{ ok: boolean; error: string; modelCount?: number }>(testRes)
    expect(body.ok).toBe(false)
    expect(body.modelCount).toBeUndefined()
    expect(body.error).toContain('No live models were returned')
  })
})
