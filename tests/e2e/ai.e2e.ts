import { expect, test, type Locator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import {
  ANONYMOUS_STATE,
  completeStepUp,
  login,
  loginAs,
} from './helpers'
import { openSiteEditor } from './helpers/editor'

const OFFLINE_OLLAMA_URL = 'http://127.0.0.1:1'

async function addOllamaCredential(
  page: Page,
  label: string,
  baseUrl = OFFLINE_OLLAMA_URL,
) {
  await page.getByRole('button', { name: 'Add credential' }).click()

  const dialog = page.getByRole('dialog', { name: 'Add AI credential' })
  await expect(dialog).toBeVisible()

  await dialog.getByRole('combobox', { name: 'Provider' }).click()
  await page.getByRole('option', { name: 'Ollama (local)' }).click()

  await expect(dialog.getByLabel('Base URL')).toBeVisible()
  await expect(dialog.getByLabel('Bearer token (optional)')).toBeVisible()
  await expect(dialog.getByLabel('API key')).toHaveCount(0)

  await dialog.getByLabel('Display label').fill(label)
  await dialog.getByLabel('Base URL').fill(baseUrl)
  await dialog.getByRole('button', { name: 'Add credential' }).click()
}

async function addOfflineOllamaCredential(page: Page, label: string) {
  await addOllamaCredential(page, label)
}

interface FakeOllamaToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

async function startFakeOllamaServer(
  responseText = 'E2E audit reply.',
  toolCall?: FakeOllamaToolCall,
): Promise<{
  baseUrl: string
  requests: { tags: number; chats: number; chatBodies: string[] }
  close: () => Promise<void>
}> {
  const requests = { tags: 0, chats: 0, chatBodies: [] as string[] }
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      requests.tags += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'e2e-model' }] }))
      return
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      req.on('end', () => {
        requests.chats += 1
        requests.chatBodies.push(Buffer.concat(chunks).toString('utf8'))

        res.writeHead(200, {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream',
        })

        if (toolCall && requests.chats === 1) {
          res.write(`data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: toolCall.id,
                      type: 'function',
                      function: {
                        name: toolCall.name,
                        arguments: JSON.stringify(toolCall.input),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`)
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          })}\n\n`)
          res.end('data: [DONE]\n\n')
          return
        }

        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: responseText }, finish_reason: null }],
        })}\n\n`)
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":123,"completion_tokens":45}}\n\n')
        res.end('data: [DONE]\n\n')
      })
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Fake Ollama server did not bind to a TCP port.')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function createRole(
  page: Page,
  name: string,
  capabilityLabels: readonly string[],
): Promise<void> {
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Roles', exact: true }).click()
  await page.getByRole('button', { name: 'Create Role', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Create Role' })
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  for (const label of capabilityLabels) {
    await setCapabilityChecked(dialog, label, true)
  }

  await page.locator('button[form="users-page-role-form"]').click()
  await completeStepUp(page)
  await expect(dialog).toBeHidden()
}

async function setRoleCapabilities(
  page: Page,
  roleName: string,
  capabilityLabels: readonly string[],
): Promise<void> {
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Roles', exact: true }).click()
  await openRoleAction(page, roleName, 'Edit')

  const dialog = page.getByRole('dialog', { name: 'Edit Role' })
  await expect(dialog).toBeVisible()
  const managedLabels = ['View site', 'Use AI chat', 'Manage AI providers']
  for (const label of managedLabels) {
    await setCapabilityChecked(dialog, label, capabilityLabels.includes(label))
  }

  await page.locator('button[form="users-page-role-form"]').click()
  await completeStepUp(page)
  await expect(dialog).toBeHidden()
}

async function createUser(
  page: Page,
  user: { email: string; displayName: string; password: string; role: string },
): Promise<void> {
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Create User', exact: true }).click()
  await page.locator('input[name="new-user-email-address"]').fill(user.email)
  await page.locator('input[name="new-user-display-name"]').fill(user.displayName)
  await page.locator('input[name="new-user-initial-password"]').fill(user.password)
  await page.locator('select[name="new-user-role"]').selectOption({ label: user.role })
  await page.locator('button[form="users-page-user-form"]').click()
  await completeStepUp(page)
}

async function openReadableSiteEditor(page: Page): Promise<void> {
  if (!(await page.getByTestId('canvas-root').isVisible({ timeout: 1_000 }).catch(() => false))) {
    await page.goto('/admin/site')
  }
  await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
}

async function setCapabilityChecked(
  dialog: Locator,
  label: string,
  checked: boolean,
): Promise<void> {
  const checkbox = dialog.getByRole('checkbox', {
    name: new RegExp(`^${escapeRegExp(label)}\\b`),
  })
  await checkbox.setChecked(checked, { force: true })
}

async function openRoleAction(page: Page, roleName: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${roleName}` }).click()
  await page
    .getByRole('menu', { name: `Role actions for ${roleName}` })
    .getByRole('menuitem', { name: action })
    .click()
}

function toolNamesFromChatBody(rawBody: string): string[] {
  const body: unknown = JSON.parse(rawBody)
  if (!isRecord(body) || !Array.isArray(body.tools)) return []
  return body.tools.flatMap((tool) => {
    if (!isRecord(tool)) return []
    const definition = tool.function
    if (!isRecord(definition) || typeof definition.name !== 'string') return []
    return [definition.name]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * AI-001 — manage provider credentials without depending on external provider
 * availability. The stable browser contract is that an operator can create an
 * Ollama base-URL credential, see the safe credential projection, and delete it.
 */
test.describe('AI settings', () => {
  test('creates and deletes an Ollama provider credential (AI-001)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const label = `E2E Ollama ${suffix}`

    await page.goto('/admin/ai')
    await expect(page.getByRole('heading', { name: 'AI' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Providers' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await test.step('create an Ollama base URL credential', async () => {
      await addOfflineOllamaCredential(page, label)
    })

    const credentialCard = page.locator('div').filter({ hasText: label }).first()
    await expect(credentialCard).toBeVisible({ timeout: 20_000 })
    await expect(credentialCard).toContainText('Ollama')
    await expect(credentialCard).toContainText('Endpoint URL')
    await expect(credentialCard.getByRole('button', { name: 'Test' })).toBeVisible()
    await expect(credentialCard.getByRole('button', { name: 'Delete' })).toBeVisible()

    await test.step('delete the created credential', async () => {
      await credentialCard.getByRole('button', { name: 'Delete' }).click()
      await expect(page.getByText(label)).toHaveCount(0)
    })
  })

  test('sets and reloads a data-scope default model (AI-002)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const label = `E2E Defaults Ollama ${suffix}`

    await page.goto('/admin/ai')
    await expect(page.getByRole('heading', { name: 'AI' })).toBeVisible()

    await test.step('create a credential for the defaults picker', async () => {
      await addOfflineOllamaCredential(page, label)
      await expect(page.getByText(label)).toBeVisible({ timeout: 20_000 })
    })

    await test.step('choose and save a Data default model', async () => {
      await page.getByRole('tab', { name: 'Defaults' }).click()
      await expect(page.getByRole('heading', { name: 'Per-scope defaults' })).toBeVisible()

      const dataModelButton = page.getByRole('button', { name: 'Model for data' })
      await dataModelButton.click()
      await expect(page.getByRole('menuitemradio', { name: 'Llama 4' })).toBeVisible({
        timeout: 20_000,
      })
      await page.getByRole('menuitemradio', { name: 'Llama 4' }).click()

      await expect(dataModelButton).toContainText(`${label} · Llama 4`)
      await page
        .locator('div')
        .filter({ hasText: /^dataUsed by the data workspace/ })
        .getByRole('button', { name: 'Save' })
        .click()
      await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    })

    await test.step('reload and verify the saved default resolves', async () => {
      await page.reload()
      await expect(page.getByRole('heading', { name: 'AI' })).toBeVisible()
      await page.getByRole('tab', { name: 'Defaults' }).click()
      await expect(page.getByRole('button', { name: 'Model for data' })).toContainText(
        `${label} · Llama 4`,
        { timeout: 20_000 },
      )
    })

    await test.step('clear the default and delete the credential', async () => {
      await page
        .locator('div')
        .filter({ hasText: /^dataUsed by the data workspace/ })
        .getByRole('button', { name: 'Clear' })
        .click()
      await expect(page.getByRole('status').filter({ hasText: 'Cleared.' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Model for data' })).toContainText(
        'Choose a model',
      )

      await page.getByRole('tab', { name: 'Providers' }).click()
      const credentialCard = page.locator('div').filter({ hasText: label }).first()
      await expect(credentialCard).toBeVisible()
      await credentialCard.getByRole('button', { name: 'Delete' }).click()
      await expect(page.getByText(label)).toHaveCount(0)
    })
  })

  test('streams a site chat and renders audit usage rollups (AI-004, AI-006)', async ({
    page,
  }) => {
    const fakeOllama = await startFakeOllamaServer()
    const suffix = Date.now().toString(36)
    const label = `E2E Live Ollama ${suffix}`

    try {
      await test.step('create a live local credential for chat', async () => {
        await page.goto('/admin/ai')
        await expect(page.getByRole('heading', { name: 'AI' })).toBeVisible()
        await addOllamaCredential(page, label, fakeOllama.baseUrl)
        await expect(page.getByText(label)).toBeVisible({ timeout: 20_000 })
        await expect.poll(() => fakeOllama.requests.tags).toBeGreaterThan(0)
      })

      await test.step('send a site assistant message through the fake provider', async () => {
        await openSiteEditor(page)
        await page.getByRole('button', { name: 'Open AI assistant panel' }).click()
        const assistantPanel = page.getByRole('complementary', { name: 'AI Assistant' })
        await expect(assistantPanel).toBeVisible()

        const composer = assistantPanel.getByLabel('Message to AI assistant')
        await expect(composer).toBeEnabled({ timeout: 20_000 })
        await composer.fill('Summarize the current page for the audit test.')
        await assistantPanel.getByRole('button', { name: 'Send' }).click()

        await expect(assistantPanel.getByText('E2E audit reply.')).toBeVisible({
          timeout: 20_000,
        })
        await expect.poll(() => fakeOllama.requests.chats).toBe(1)
      })

      await test.step('verify the Audit tab shows the persisted usage', async () => {
        await page.goto('/admin/ai')
        await page.getByRole('tab', { name: 'Audit' }).click()
        await expect(page.getByRole('heading', { name: 'Usage audit' })).toBeVisible()
        await expect(page.getByText('e2e-model')).toBeVisible({ timeout: 20_000 })
        await expect(page.getByRole('heading', { name: 'By surface' })).toBeVisible()
        await expect(page.getByRole('cell', { name: 'site' })).toBeVisible()
        await expect(page.getByRole('cell', { name: '123' }).first()).toBeVisible()
        await expect(page.getByRole('cell', { name: '45' }).first()).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Daily spend' })).toBeVisible()
      })

      await test.step('clear seeded defaults and delete the credential', async () => {
        await page.evaluate(async () => {
          const conversationsRes = await fetch('/admin/api/ai/conversations?scope=site')
          if (!conversationsRes.ok) {
            throw new Error(`Failed to list site conversations: ${conversationsRes.status}`)
          }
          const conversationsBody = await conversationsRes.json()
          if (!Array.isArray(conversationsBody.conversations)) {
            throw new Error('Conversation list response did not include an array.')
          }
          for (const conversation of conversationsBody.conversations) {
            if (typeof conversation?.id !== 'string') {
              throw new Error('Conversation list response included an invalid id.')
            }
            const res = await fetch(`/admin/api/ai/conversations/${conversation.id}`, {
              method: 'DELETE',
            })
            if (!res.ok) throw new Error(`Failed to delete conversation ${conversation.id}: ${res.status}`)
          }
          for (const scope of ['site', 'content', 'data', 'plugin']) {
            const res = await fetch(`/admin/api/ai/defaults/${scope}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`Failed to clear ${scope} default: ${res.status}`)
          }
        })
        await page.getByRole('tab', { name: 'Providers' }).click()
        const credentialCard = page.locator('div').filter({ hasText: label }).first()
        await expect(credentialCard).toBeVisible()
        await credentialCard.getByRole('button', { name: 'Delete' }).click()
        await expect(page.getByText(label)).toHaveCount(0)
      })
    } finally {
      await fakeOllama.close()
    }
  })

  test('returns a browser tool result to the model loop (AI-005)', async ({
    page,
  }) => {
    const fakeOllama = await startFakeOllamaServer('E2E bridge reply.', {
      id: 'call_site_read_document',
      name: 'site_read_document',
      input: {},
    })
    const suffix = Date.now().toString(36)
    const label = `E2E Bridge Ollama ${suffix}`

    try {
      await test.step('create a live local credential for the tool loop', async () => {
        await page.goto('/admin/ai')
        await expect(page.getByRole('heading', { name: 'AI' })).toBeVisible()
        await addOllamaCredential(page, label, fakeOllama.baseUrl)
        await expect(page.getByText(label)).toBeVisible({ timeout: 20_000 })
        await expect.poll(() => fakeOllama.requests.tags).toBeGreaterThan(0)
      })

      await test.step('send a prompt that triggers a browser-backed read tool', async () => {
        await openSiteEditor(page)
        await page.getByRole('button', { name: 'Open AI assistant panel' }).click()
        const assistantPanel = page.getByRole('complementary', { name: 'AI Assistant' })
        await expect(assistantPanel).toBeVisible()

        const composer = assistantPanel.getByLabel('Message to AI assistant')
        await expect(composer).toBeEnabled({ timeout: 20_000 })
        await composer.fill('Read the current document, then summarize it.')
        await assistantPanel.getByRole('button', { name: 'Send' }).click()

        await expect(
          assistantPanel.getByRole('status', { name: 'Completed Reading document' }),
        ).toBeVisible({ timeout: 20_000 })
        await expect(assistantPanel.getByText('E2E bridge reply.')).toBeVisible({
          timeout: 20_000,
        })
      })

      await test.step('verify the provider received the browser tool result turn', async () => {
        await expect.poll(() => fakeOllama.requests.chats).toBe(2)
        const firstBody = fakeOllama.requests.chatBodies[0] ?? ''
        const secondBody = fakeOllama.requests.chatBodies[1] ?? ''
        expect(firstBody).toContain('"tools"')
        expect(firstBody).toContain('"site_read_document"')
        expect(secondBody).toContain('"role":"tool"')
        expect(secondBody).toContain('"tool_call_id":"call_site_read_document"')
      })

      await test.step('clear seeded conversations/defaults and delete the credential', async () => {
        await page.evaluate(async () => {
          const conversationsRes = await fetch('/admin/api/ai/conversations?scope=site')
          if (!conversationsRes.ok) {
            throw new Error(`Failed to list site conversations: ${conversationsRes.status}`)
          }
          const conversationsBody = await conversationsRes.json()
          if (!Array.isArray(conversationsBody.conversations)) {
            throw new Error('Conversation list response did not include an array.')
          }
          for (const conversation of conversationsBody.conversations) {
            if (typeof conversation?.id !== 'string') {
              throw new Error('Conversation list response included an invalid id.')
            }
            const res = await fetch(`/admin/api/ai/conversations/${conversation.id}`, {
              method: 'DELETE',
            })
            if (!res.ok) throw new Error(`Failed to delete conversation ${conversation.id}: ${res.status}`)
          }
          for (const scope of ['site', 'content', 'data', 'plugin']) {
            const res = await fetch(`/admin/api/ai/defaults/${scope}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`Failed to clear ${scope} default: ${res.status}`)
          }
        })
        await page.goto('/admin/ai')
        const credentialCard = page.locator('div').filter({ hasText: label }).first()
        await expect(credentialCard).toBeVisible()
        await credentialCard.getByRole('button', { name: 'Delete' }).click()
        await expect(page.getByText(label)).toHaveCount(0)
      })
    } finally {
      await fakeOllama.close()
    }
  })

  test('loads and deletes a saved site chat from conversation history (AI-003)', async ({
    page,
  }) => {
    const fakeOllama = await startFakeOllamaServer('E2E conversation reply.')
    const suffix = Date.now().toString(36)
    const label = `E2E History Ollama ${suffix}`
    const prompt = 'Summarize the current page for conversation history.'

    try {
      await test.step('create a live local credential for the conversation', async () => {
        await page.goto('/admin/ai')
        await expect(page.getByRole('heading', { name: 'AI' })).toBeVisible()
        await addOllamaCredential(page, label, fakeOllama.baseUrl)
        await expect(page.getByText(label)).toBeVisible({ timeout: 20_000 })
        await expect.poll(() => fakeOllama.requests.tags).toBeGreaterThan(0)
      })

      await test.step('create a persisted site conversation', async () => {
        await openSiteEditor(page)
        await page.getByRole('button', { name: 'Open AI assistant panel' }).click()
        const assistantPanel = page.getByRole('complementary', { name: 'AI Assistant' })
        await expect(assistantPanel).toBeVisible()

        const composer = assistantPanel.getByLabel('Message to AI assistant')
        await expect(composer).toBeEnabled({ timeout: 20_000 })
        await composer.fill(prompt)
        await assistantPanel.getByRole('button', { name: 'Send' }).click()

        await expect(assistantPanel.getByText(prompt)).toBeVisible()
        await expect(assistantPanel.getByText('E2E conversation reply.')).toBeVisible({
          timeout: 20_000,
        })
        await expect.poll(() => fakeOllama.requests.chats).toBe(1)
      })

      await test.step('start a fresh chat and reload the saved one from history', async () => {
        const assistantPanel = page.getByRole('complementary', { name: 'AI Assistant' })
        await assistantPanel.getByRole('button', { name: 'New chat' }).click()
        await expect(assistantPanel.getByText('E2E conversation reply.')).toHaveCount(0)

        await assistantPanel.getByRole('button', { name: 'Conversation history' }).click()
        const menu = page.getByRole('menu', { name: 'Conversation history' })
        const savedChat = menu
          .getByRole('menuitemradio')
          .filter({ hasText: prompt })
          .first()
        await expect(savedChat).toBeVisible()
        await savedChat.click()

        await expect(assistantPanel.getByText(prompt)).toBeVisible()
        await expect(assistantPanel.getByText('E2E conversation reply.')).toBeVisible()
      })

      await test.step('delete the active conversation from history', async () => {
        const assistantPanel = page.getByRole('complementary', { name: 'AI Assistant' })
        await assistantPanel.getByRole('button', { name: 'Conversation history' }).click()
        const menu = page.getByRole('menu', { name: 'Conversation history' })
        await menu.getByRole('button', { name: `Delete chat "${prompt}"` }).click()
        await expect(menu.getByText('No chats yet.')).toBeVisible()
        await expect(assistantPanel.getByText('E2E conversation reply.')).toHaveCount(0)
      })

      await test.step('clear seeded defaults and delete the credential', async () => {
        await page.evaluate(async () => {
          for (const scope of ['site', 'content', 'data', 'plugin']) {
            const res = await fetch(`/admin/api/ai/defaults/${scope}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`Failed to clear ${scope} default: ${res.status}`)
          }
        })
        await page.goto('/admin/ai')
        const credentialCard = page.locator('div').filter({ hasText: label }).first()
        await expect(credentialCard).toBeVisible()
        await credentialCard.getByRole('button', { name: 'Delete' }).click()
        await expect(page.getByText(label)).toHaveCount(0)
      })
    } finally {
      await fakeOllama.close()
    }
  })
})

/**
 * CAP-005 — a user with `ai.chat` but no `ai.tools.write` can use the Site
 * assistant, while the model request only receives read/orientation tools.
 */
test.describe.serial('AI write-tool capability filtering', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(180_000)

  test('chat-only site assistant request omits mutating write tools (CAP-005)', async ({
    page,
    browser,
  }) => {
    const fakeOllama = await startFakeOllamaServer('E2E read-only tools reply.')
    const suffix = Date.now().toString(36)
    const roleName = `CAP AI Chat Only ${suffix}`
    const email = `cap-ai-chat-only-${suffix}@example.com`
    const password = 'cap-ai-chat-only-pass-12345'
    const label = `CAP Chat Tools Ollama ${suffix}`
    let credentialCreated = false

    try {
      await test.step('owner creates a temporary provider-setup chat persona', async () => {
        await login(page)
        await createRole(page, roleName, [
          'View site',
          'Use AI chat',
          'Manage AI providers',
        ])
        await createUser(page, {
          email,
          displayName: roleName,
          password,
          role: roleName,
        })
      })

      const personaContext = await browser.newContext({ storageState: ANONYMOUS_STATE })
      const personaPage = await personaContext.newPage()
      try {
        await test.step('persona creates its own disposable fake-provider credential', async () => {
          await loginAs(personaPage, email, password)
          await personaPage.goto('/admin/ai')
          await expect(personaPage.getByRole('heading', { name: 'AI' })).toBeVisible()
          await addOllamaCredential(personaPage, label, fakeOllama.baseUrl)
          credentialCreated = true
          await expect(personaPage.getByText(label)).toBeVisible({ timeout: 20_000 })
          await expect.poll(() => fakeOllama.requests.tags).toBeGreaterThan(0)
        })

        await test.step('owner removes provider setup so the persona keeps ai.chat only', async () => {
          await setRoleCapabilities(page, roleName, [
            'View site',
            'Use AI chat',
          ])
        })

        await test.step('persona sends a site assistant message after the downgrade', async () => {
          await openReadableSiteEditor(personaPage)
          await personaPage.getByRole('button', { name: 'Open AI assistant panel' }).click()
          const assistantPanel = personaPage.getByRole('complementary', { name: 'AI Assistant' })
          await expect(assistantPanel).toBeVisible()

          const composer = assistantPanel.getByLabel('Message to AI assistant')
          await expect(composer).toBeEnabled({ timeout: 20_000 })
          await composer.fill('Read the current document without changing anything.')
          await assistantPanel.getByRole('button', { name: 'Send' }).click()

          await expect(assistantPanel.getByText('E2E read-only tools reply.')).toBeVisible({
            timeout: 20_000,
          })
        })

        await test.step('provider request contains read tools but no mutating tools', async () => {
          await expect.poll(() => fakeOllama.requests.chats).toBe(1)
          const toolNames = toolNamesFromChatBody(fakeOllama.requests.chatBodies[0] ?? '')
          expect(toolNames).toContain('site_read_document')
          expect(toolNames).toContain('site_render_snapshot')
          expect(toolNames).not.toContain('site_insert_html')
          expect(toolNames).not.toContain('site_replace_node_html')
          expect(toolNames).not.toContain('site_update_node_props')
          expect(toolNames).not.toContain('site_apply_css')
          expect(toolNames).not.toContain('site_write_code_asset')
          expect(toolNames).not.toContain('site_add_page')
          expect(toolNames).not.toContain('site_delete_page')
        })
      } finally {
        if (credentialCreated) {
          // Credential creation auto-seeds the site-wide defaults. Restore the
          // temporary capability so the persona can remove the fixture it owns,
          // then clear those defaults before deletion (the FK is restrictive).
          await setRoleCapabilities(page, roleName, [
            'View site',
            'Use AI chat',
            'Manage AI providers',
          ])
          await personaPage.evaluate(async () => {
            for (const scope of ['site', 'content', 'data', 'plugin']) {
              const response = await fetch(`/admin/api/ai/defaults/${scope}`, {
                method: 'DELETE',
              })
              if (!response.ok) {
                throw new Error(`Failed to clear ${scope} default: ${response.status}`)
              }
            }
          })
          await personaPage.goto('/admin/ai')
          const credentialCard = personaPage.locator('div').filter({ hasText: label }).first()
          await expect(credentialCard).toBeVisible()
          await credentialCard.getByRole('button', { name: 'Delete' }).click()
          await expect(personaPage.getByText(label)).toHaveCount(0)
        }
        await personaContext.close()
      }
    } finally {
      await fakeOllama.close()
    }
  })
})
