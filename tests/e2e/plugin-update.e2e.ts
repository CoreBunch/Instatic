import { expect, test } from '@playwright/test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { ANONYMOUS_STATE, completeStepUp, login } from './helpers'

test.use({ storageState: ANONYMOUS_STATE })
test('signed update survives a failed download, reviews permissions and preserves settings', async ({ page }) => {
  test.setTimeout(120000)
  const pair = generateKeyPairSync('ed25519')
  const publicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64')
  const source = process.env.E2E_SIGNED_PLUGIN_FIXTURE
  const files = source ? unzipSync(readFileSync(source)) : {}
  const manifest = source ? JSON.parse(strFromU8(files['plugin.json']!)) : {
    id: 'e2e.signed-update', name: 'Signed update fixture', apiVersion: 1, permissions: ['cms.routes', 'network.outbound'], entrypoints: { server: 'server/index.js' },
    networkAllowedHosts: ['library.instatic.test'], settings: [{ id: 'mode', type: 'text', label: 'Mode' }],
  }
  const url = 'https://library.instatic.test/release-assets/e2e'
  function zip(version: string, offered: object) {
    const server: Record<string, Uint8Array> = source ? {} : { 'server/index.js': strToU8(
      "export function activate(api) { api.cms.routes.get('/updates/check', 'plugins.install', () => (" + JSON.stringify(offered) + ")) }",
    ) }
    const permissions = version === '0.11.23' ? [...manifest.permissions, 'cms.storage'] : manifest.permissions
    return Buffer.from(zipSync({
      ...files, ...server, 'plugin.json': strToU8(JSON.stringify({ ...manifest, version, updatePublicKey: publicKey, permissions })),
    }))
  }
  const after = zip('0.11.23', { status: 'current' })
  const offer = { status: 'available', version: '0.11.23', notes: 'Test upgrade', signature: sign(null, after, pair.privateKey).toString('base64'), url }
  const before = zip('0.11.22', offer)
  let mode = 'broken'
  let current = false
  if (source) await page.route('**/runtime/updates/check', route => route.fulfill({ json: current ? { status: 'current' } : offer }))
  await page.route(url, route => mode === 'broken' ? route.abort('failed') : route.fulfill({
    contentType: 'application/zip', headers: { 'Access-Control-Allow-Origin': '*' }, body: mode === 'tampered' ? before : after,
  }))
  await login(page)
  await page.goto('/admin/plugins')
  await page.getByLabel('Plugin file').setInputFiles({ name: 'installed.zip', mimeType: 'application/zip', buffer: before })
  await page.getByRole('button', { name: 'Approve and Install' }).click()
  await completeStepUp(page)
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: manifest.name, exact: true }) })
  const settingsButton = card.getByRole('button', { name: 'Edit settings for ' + manifest.name })
  if (source) {
    const response = await page.request.get('/admin/api/cms/plugins/' + manifest.id + '/runtime/updates/check')
    expect(response.ok()).toBe(true)
    expect(await response.json()).toMatchObject({ status: 'disconnected' })
  }
  await settingsButton.click()
  const dialog = page.getByRole('dialog', { name: manifest.name })
  const field = dialog.getByLabel(source ? 'Library connection' : 'Mode')
  await field.fill('local-update-test-value')
  await dialog.getByRole('button', { name: 'Save settings' }).click()
  await completeStepUp(page)
  const update = card.getByRole('button', { name: 'Update to 0.11.23' })
  await update.click()
  await expect(page.getByText('Could not update ' + manifest.name).first()).toBeVisible()
  await expect(card).toContainText('v0.11.22')
  mode = 'tampered'
  await update.click()
  await expect(page.getByText('The package signature does not match the installed publisher key.')).toBeVisible()
  await expect(card).toContainText('v0.11.22')
  mode = 'valid'
  await update.click()
  await expect(page.getByText(/0\.11\.22.*0\.11\.23/).first()).toBeVisible()
  await expect(page.locator('[data-permission="cms.storage"][data-status="new"]')).toBeVisible()
  await page.screenshot({ path: '.tmp/evidence/signed-plugin-update-review.png' })
  current = true
  await page.locator('section[aria-labelledby="plugin-permissions-title"]').getByRole('button', { name: /update to 0.11.23/i }).click()
  await completeStepUp(page)
  await expect(card).toContainText('v0.11.23')
  await page.reload()
  await expect(card).toContainText('v0.11.23')
  await settingsButton.click()
  if (source) await expect(field).toHaveValue('***')
  else await expect(field).toHaveValue('local-update-test-value')
})
