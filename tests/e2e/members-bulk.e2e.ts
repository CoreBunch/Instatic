import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, completeStepUp, login } from './helpers'

// The import and the export ask for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

/**
 * MEMBER-008 — import members from a CSV file and export every member.
 *
 * The owner checks a file first (new, already members, not valid with the
 * reason), imports it behind the password prompt, finds the new members as
 * pending in the list, exports everyone as JSON, and sees both in the Audit
 * tab.
 */
test('owner imports members from a file and exports every member (MEMBER-008)', async ({ page }) => {
  await login(page)
  await page.goto('/admin/users')
  await page.getByRole('tab', { name: 'Site members', exact: true }).click()
  const tab = page.getByRole('region', { name: 'Site members' })

  const suffix = Date.now().toString(36)
  const first = `import-a-${suffix}@example.com`
  const second = `import-b-${suffix}@example.com`
  const csv = [
    'email,name,tags',
    `${first},Imported Ada,import-${suffix}`,
    `${second},Imported Grace,`,
    `reserved-${suffix}@example.com,,instatic:admin`,
    'not-an-address,,',
  ].join('\n')

  await test.step('check the file, then import it', async () => {
    await tab.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import members' })
    await expect(dialog.getByRole('button', { name: 'Check file' })).toBeDisabled()
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'members.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(dialog.getByText('members.csv (CSV)')).toBeVisible()
    // Invitations need a published invitation page, which this site does not have.
    await expect(dialog.getByRole('switch', { name: 'Email an invitation to each new member' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Check file' }).click()

    const counts = dialog.getByRole('status')
    await expect(counts.getByText('Rows', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText('4')
    await expect(counts.getByText('New', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText('2')
    await expect(counts.getByText('Not valid', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText('2')
    await expect(dialog.getByText('The tag "instatic:admin" cannot be given to a member')).toBeVisible()
    await expect(dialog.getByText('Not a valid email address')).toBeVisible()
    await page.screenshot({ path: '.tmp/evidence/members-import-preview.png' })

    await dialog.getByRole('button', { name: 'Import 2 members' }).click()
    await completeStepUp(page)
    const done = page.getByRole('dialog', { name: 'Import finished' })
    await expect(done.getByText('Added', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText('2')
    await page.screenshot({ path: '.tmp/evidence/members-import-result.png' })
    await done.getByRole('button', { name: 'Back to members' }).click()
  })

  await test.step('the imported members are pending, with their tag', async () => {
    await tab.getByLabel('Search name or email').fill(`import-a-${suffix}`)
    const row = tab.getByRole('list', { name: 'Site members' }).getByRole('button', { name: /Imported Ada/ })
    await expect(row).toBeVisible()
    await expect(row).toContainText('Pending')
    await expect(row).toContainText(`import-${suffix}`)
  })

  await test.step('export every member as JSON', async () => {
    await tab.getByRole('button', { name: 'Export all' }).click()
    const dialog = page.getByRole('dialog', { name: 'Export members' })
    await dialog.getByRole('button', { name: 'JSON', exact: true }).click()
    await page.screenshot({ path: '.tmp/evidence/members-export.png' })
    const downloading = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download JSON' }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/^members-\d{4}-\d{2}-\d{2}\.json$/)
    const body = JSON.parse(await readFile(await download.path(), 'utf8')) as {
      members: Array<{ email: string; name: string; status: string; tags: string[] }>
    }
    expect(body.members).toContainEqual(expect.objectContaining({ email: first, name: 'Imported Ada', status: 'pending', tags: [`import-${suffix}`] }))
    expect(body.members.map((member) => member.email)).toContain(second)
    await expect(dialog).toBeHidden()
  })

  await test.step('both are in the audit log', async () => {
    await page.getByRole('tab', { name: 'Audit', exact: true }).click()
    await expect(page.getByText(/Members were imported: 2 added/).first()).toBeVisible()
    await expect(page.getByText(/Every member was exported \(\d+ members, json\)/).first()).toBeVisible()
  })
})
