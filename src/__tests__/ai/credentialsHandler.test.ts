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

  it('creates an OpenAI OAuth credential through the device flow without leaking tokens', async () => {
    const cookie = await harness.setupOwner()
    const accessToken = fakeJwt({ chatgpt_account_id: 'acct_test' })
    const refreshToken = 'refresh-secret-test-token'

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        expect(init?.method).toBe('POST')
        return new Response(JSON.stringify({
          device_auth_id: 'device-auth-1',
          user_code: 'ABCD-EFGH',
          interval: '1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        expect(init?.method).toBe('POST')
        expect(String(init?.body)).toContain('device-auth-1')
        return new Response(JSON.stringify({
          authorization_code: 'authorization-code-1',
          code_verifier: 'verifier-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://auth.openai.com/oauth/token') {
        expect(init?.method).toBe('POST')
        expect(String(init?.body)).toContain('authorization-code-1')
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return originalFetch(input, init)
    }

    const startRes = await harness.ai('/admin/api/ai/oauth/openai/device/start', {
      method: 'POST',
      cookie,
      json: { displayLabel: 'ChatGPT OAuth' },
    })
    expect(startRes.status).toBe(200)
    const startBody = await readJson<{
      flowId: string
      userCode: string
      verificationUrl: string
      intervalMs: number
    }>(startRes)
    expect(startBody.userCode).toBe('ABCD-EFGH')
    expect(startBody.verificationUrl).toBe('https://auth.openai.com/codex/device')
    expect(JSON.stringify(startBody)).not.toContain(accessToken)
    expect(JSON.stringify(startBody)).not.toContain(refreshToken)

    const completeRes = await harness.ai('/admin/api/ai/oauth/openai/device/complete', {
      method: 'POST',
      cookie,
      json: { flowId: startBody.flowId },
    })
    expect(completeRes.status).toBe(200)
    const completeBody = await readJson<{
      status: 'success'
      credential: { id: string; providerId: string; authMode: string; displayLabel: string }
    }>(completeRes)
    expect(completeBody.status).toBe('success')
    expect(completeBody.credential).toMatchObject({
      providerId: 'openai',
      authMode: 'oauth',
      displayLabel: 'ChatGPT OAuth',
    })
    expect(JSON.stringify(completeBody)).not.toContain(accessToken)
    expect(JSON.stringify(completeBody)).not.toContain(refreshToken)

    const { rows } = await harness.db<{
      provider_id: string
      auth_mode: string
      ciphertext: Uint8Array | null
      iv: Uint8Array | null
      base_url: string | null
    }>`
      select provider_id, auth_mode, ciphertext, iv, base_url
      from ai_provider_credentials
      where id = ${completeBody.credential.id}
    `
    expect(rows[0]).toMatchObject({
      provider_id: 'openai',
      auth_mode: 'oauth',
      base_url: null,
    })
    expect(rows[0]?.ciphertext).toBeInstanceOf(Uint8Array)
    expect(rows[0]?.iv).toBeInstanceOf(Uint8Array)

    const defaults = await harness.db<{ count: number; model_id: string }>`
      select count(*) as count, min(model_id) as model_id
      from ai_defaults
    `
    expect(defaults.rows[0]?.count).toBe(4)
    expect(defaults.rows[0]?.model_id).toBe('gpt-5.5')
  })
})

function fakeJwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: 'none', typ: 'JWT' })}.${base64UrlJson(payload)}.signature`
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
