import { expect } from 'bun:test'
import type { CoreCapability } from '../../../server/auth/capabilities'
import { SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest, type CmsHandlerOptions } from '../../../server/handlers/cms'
import { tryHandleAi } from '../../../server/ai/handlers'
import { createTestDb, type TestDb } from './createTestDb'

const CAPABILITY_TEST_PASSWORD = 'long-enough-password'

let harnessSerial = 0

interface HarnessRequestInit extends Omit<RequestInit, 'body'> {
  cookie?: string
  body?: BodyInit | null
  json?: unknown
}

interface TestRoleUser {
  cookie: string
  email: string
  roleId: string
}

export interface CapabilityTestHarness extends TestDb {
  cms(path: string, options?: HarnessRequestInit): Promise<Response>
  ai(path: string, options?: HarnessRequestInit): Promise<Response>
  setupOwner(): Promise<string>
  sessionForEmail(email: string): Promise<string>
  stepUp(cookie: string): Promise<string>
  createRole(input: {
    name: string
    slug: string
    capabilities: CoreCapability[]
  }): Promise<string>
  createUser(input: {
    email: string
    displayName?: string
    roleId: string
  }): Promise<void>
  createRoleUser(input: {
    name: string
    slug: string
    capabilities: CoreCapability[]
    email?: string
    displayName?: string
  }): Promise<TestRoleUser>
}

function requestBody(options: HarnessRequestInit): BodyInit | null | undefined {
  if ('json' in options) return JSON.stringify(options.json)
  return options.body
}

function buildRequest(path: string, options: HarnessRequestInit = {}): Request {
  const headers = new Headers(options.headers)
  if ('json' in options && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const req = new Request(`http://localhost${path}`, {
    ...options,
    headers,
    body: requestBody(options),
  })
  if (options.cookie) req.headers.set('cookie', options.cookie)
  return req
}

export async function readJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

export async function expectForbidden(res: Response): Promise<void> {
  expect(res.status).toBe(403)
  const body = await readJson<{ error?: string }>(res)
  expect(body.error).toBe('Forbidden')
}

async function expectUnauthorized(res: Response): Promise<void> {
  expect(res.status).toBe(401)
}

export async function expectStepUpRequired(res: Response): Promise<void> {
  expect(res.status).toBe(401)
  const body = await readJson<{ error?: string }>(res)
  expect(body.error).toBe('step_up_required')
}

export function expectPastAuth(res: Response): void {
  expect(res.status).not.toBe(401)
  expect(res.status).not.toBe(403)
}

export async function createCapabilityTestHarness(
  options: CmsHandlerOptions = {},
): Promise<CapabilityTestHarness> {
  const testDb = await createTestDb()
  const { db } = testDb
  const emailSuffix = `${Date.now()}-${++harnessSerial}`
  const ownerEmail = `owner-${emailSuffix}@example.com`
  let ownerCookie: string | null = null

  const cms = (path: string, requestOptions: HarnessRequestInit = {}) => {
    const req = buildRequest(path, requestOptions)
    return handleCmsRequest(req, db, options)
  }

  const ai = async (path: string, requestOptions: HarnessRequestInit = {}) => {
    const req = buildRequest(path, requestOptions)
    const response = await tryHandleAi(req, db, new URL(req.url))
    return response ?? new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }

  async function sessionForEmail(email: string): Promise<string> {
    const res = await cms('/admin/api/cms/login', {
      method: 'POST',
      json: {
        email,
        password: CAPABILITY_TEST_PASSWORD,
      },
    })
    expect(res.status).toBe(200)
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
    return cookie
  }

  async function stepUp(cookie: string): Promise<string> {
    const res = await cms('/admin/api/cms/auth/step-up', {
      method: 'POST',
      cookie,
      json: { password: CAPABILITY_TEST_PASSWORD },
    })
    if (res.status !== 200) {
      throw new Error(`Step-up failed with ${res.status}: ${await res.text()}`)
    }
    const steppedCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    expect(steppedCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
    return steppedCookie
  }

  async function setupOwner(): Promise<string> {
    const res = await cms('/admin/api/cms/setup', {
      method: 'POST',
      json: {
        siteName: 'Capability Matrix',
        email: ownerEmail,
        password: CAPABILITY_TEST_PASSWORD,
      },
    })
    expect(res.status).toBe(201)
    ownerCookie = await stepUp(await sessionForEmail(ownerEmail))
    return ownerCookie
  }

  async function requireOwnerCookie(): Promise<string> {
    return ownerCookie ?? await setupOwner()
  }

  async function createRole(input: {
    name: string
    slug: string
    capabilities: CoreCapability[]
  }): Promise<string> {
    const res = await cms('/admin/api/cms/roles', {
      method: 'POST',
      cookie: await requireOwnerCookie(),
      json: input,
    })
    expect(res.status).toBe(201)
    const payload = await readJson<{ role: { id: string } }>(res)
    return payload.role.id
  }

  async function createUser(input: {
    email: string
    displayName?: string
    roleId: string
  }): Promise<void> {
    const res = await cms('/admin/api/cms/users', {
      method: 'POST',
      cookie: await requireOwnerCookie(),
      json: {
        email: input.email,
        displayName: input.displayName ?? input.email,
        password: CAPABILITY_TEST_PASSWORD,
        roleId: input.roleId,
      },
    })
    expect(res.status).toBe(201)
  }

  async function createRoleUser(input: {
    name: string
    slug: string
    capabilities: CoreCapability[]
    email?: string
    displayName?: string
  }): Promise<TestRoleUser> {
    const email = input.email ?? `${input.slug}-${emailSuffix}@example.com`
    const roleId = await createRole({
      name: input.name,
      slug: input.slug,
      capabilities: input.capabilities,
    })
    await createUser({
      email,
      displayName: input.displayName ?? input.name,
      roleId,
    })
    const cookie = await sessionForEmail(email)
    return { cookie, email, roleId }
  }

  return {
    ...testDb,
    cms,
    ai,
    setupOwner,
    sessionForEmail,
    stepUp,
    createRole,
    createUser,
    createRoleUser,
  }
}


