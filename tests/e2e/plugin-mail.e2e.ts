import { strToU8, zipSync } from 'fflate'
import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, OWNER, PUBLIC_BASE_URL, login } from './helpers'

/**
 * ADMIN-016 — a plugin's email templates, from a real browser.
 *
 * The owner installs a plugin that declares two email templates. They show
 * up in Email → Templates under the plugin's name, where the owner rewords
 * one. The plugin then sends that template through its own route; with no
 * connector on the E2E server the email is captured, and Activity shows it
 * with the owner's wording. Uninstalling the plugin takes the templates away.
 */

// Installing a plugin and saving a template ask for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

const PLUGIN_SOURCE = `
  export function activate(api) {
    api.cms.routes.public.post('/notify', async (ctx) => {
      try {
        return { status: await api.cms.mail.send({
          template: 'ticket.opened',
          to: { address: ctx.body.address },
          variables: { subject: ctx.body.subject },
        }) }
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) }
      }
    })
  }
`

test('a plugin\'s email templates are listed, reworded and sent (ADMIN-016)', async ({ page }) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const pluginId = `e2e.desk-${suffix}`
  const pluginName = `E2E Desk ${suffix}`
  const permissions = ['cms.routes', 'cms.routes.public', 'mail.send.external']

  await login(page)
  const admin = page.request
  const headers = { origin: new URL(page.url()).origin }
  const stepUp = async () => {
    const res = await admin.post('/admin/api/cms/auth/step-up', { headers, data: { password: OWNER.password } })
    expect(res.ok(), await res.text()).toBe(true)
  }

  try {
    await test.step('install the plugin', async () => {
      await stepUp()
      const manifest = {
        id: pluginId,
        name: pluginName,
        version: '1.0.0',
        apiVersion: 1,
        permissions,
        entrypoints: { server: 'server/index.js' },
        resources: [],
        adminPages: [],
        mail: {
          templates: [
            {
              key: 'ticket.opened',
              label: 'New ticket',
              description: 'Sent to the support inbox when a customer opens a ticket.',
              variables: [{ name: 'subject', label: 'Ticket subject', sample: 'Publishing stops at 80%' }],
              subject: 'New ticket: {subject}',
              body: 'A customer opened **{subject}**.',
            },
            {
              key: 'ticket.reply',
              label: 'Ticket reply',
              description: 'Sent to the customer when the team answers a ticket.',
              variables: [{ name: 'subject', label: 'Ticket subject', sample: 'Publishing stops at 80%' }],
              subject: 'Re: {subject}',
              body: 'We answered **{subject}**.',
            },
          ],
        },
      }
      const installed = await admin.post('/admin/api/cms/plugins/package', {
        headers,
        multipart: {
          file: {
            name: `${pluginId}.zip`,
            mimeType: 'application/zip',
            buffer: Buffer.from(zipSync({
              'plugin.json': strToU8(JSON.stringify(manifest)),
              'server/index.js': strToU8(PLUGIN_SOURCE),
            })),
          },
          grantedPermissions: JSON.stringify(permissions),
        },
      })
      expect(installed.ok(), await installed.text()).toBe(true)
    })

    await test.step('the templates are listed under the plugin and one is reworded', async () => {
      await page.goto('/admin/email')
      await page.getByTestId('email-nav-templates').click()
      const sidebar = page.getByRole('complementary', { name: 'Available templates' })
      await expect(sidebar.getByRole('heading', { name: pluginName })).toBeVisible()
      await sidebar.getByRole('button', { name: 'Ticket reply' }).click()
      await sidebar.getByRole('button', { name: 'New ticket' }).click()
      const template = page.getByRole('article')
      await expect(template.getByRole('heading', { name: 'New ticket', exact: true })).toBeVisible()
      await page.screenshot({ path: process.env.E2E_EVIDENCE_PATH ?? '.tmp/evidence/plugin-mail-templates.png' })

      const sending = template.getByRole('switch', { name: 'Sending' })
      await expect(sending).toBeChecked()
      await sending.click()
      await expect(sending).not.toBeChecked()
      await expect(sidebar.getByRole('button', { name: /New ticket.*Sending off/ })).toBeVisible()
      await expect(template.getByRole('button', { name: 'Send test' })).toBeDisabled()
      const suppressed = await admin.post(`${PUBLIC_BASE_URL}/_instatic/plugins/${pluginId}/notify`, {
        headers, data: { address: 'suppressed@example.com', subject: 'While off' },
      })
      expect(await suppressed.json()).toEqual({ status: 'disabled' })
      await sending.click()
      await expect(sending).toBeChecked()

      // Reworded through the same endpoint the editor saves to.
      await stepUp()
      const saved = await admin.put(`/admin/api/cms/mail/templates/${encodeURIComponent(`plugin.${pluginId}~ticket.opened`)}`, {
        headers,
        data: { subject: 'Desk: {subject}', body: 'Our own words about **{subject}**.' },
      })
      expect(saved.ok(), await saved.text()).toBe(true)
      await page.reload()
      await page.getByTestId('email-nav-templates').click()
      await expect(sidebar.getByRole('button', { name: /New ticket.*Edited/ })).toBeVisible()
    })

    await test.step('the plugin sends it, and Activity shows the owner\'s wording', async () => {
      const mount = `${PUBLIC_BASE_URL}/_instatic/plugins/${pluginId}`
      await expect.poll(async () => {
        const res = await admin.post(`${mount}/notify`, {
          headers,
          data: { address: `support-${suffix}@example.com`, subject: 'Cannot publish' },
        })
        return res.ok() ? ((await res.json()) as { status?: string }).status : `http ${res.status()}`
      }, { timeout: 20_000 }).toBe('captured')

      await page.getByTestId('email-nav-activity').click()
      const activity = page.getByRole('table', { name: 'Email activity' })
      await expect(activity.getByText(`support-${suffix}@example.com`)).toBeVisible()
      await activity.getByRole('button', { name: new RegExp(`support-${suffix}`) }).first().click()
      const details = page.getByRole('article', { name: 'Email details' })
      await expect(details.getByRole('heading', { name: 'Desk: Cannot publish' })).toBeVisible()
      await expect(details.getByText('Our own words about')).toBeVisible()
      await expect(details.getByText(pluginName, { exact: true })).toBeVisible()
    })
  } finally {
    await stepUp()
    await admin.delete(`/admin/api/cms/plugins/${pluginId}`, { headers })
  }

  await test.step('uninstalling takes the templates away', async () => {
    await page.reload()
    await page.getByTestId('email-nav-templates').click()
    await expect(page.getByRole('article').getByRole('heading', { name: 'Test email', exact: true })).toBeVisible()
    const sidebar = page.getByRole('complementary', { name: 'Available templates' })
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByRole('heading', { name: pluginName })).toHaveCount(0)
    // The log still says who sent the email.
    await page.getByTestId('email-nav-activity').click()
    await page.getByRole('button', { name: new RegExp(`support-${suffix}`) }).first().click()
    await expect(page.getByRole('article', { name: 'Email details' }).getByText(pluginName, { exact: true })).toBeVisible()
  })
})
