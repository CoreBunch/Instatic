import { SERVICE_CAPABILITIES } from '../../src/core/serviceAccounts'
import { expect, test } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { completeStepUp, login } from './helpers/auth'
import { ANONYMOUS_STATE } from './helpers/constants'

test.use({ storageState: ANONYMOUS_STATE })
test('connect an external CLI, work on a branch, then revoke it (AI-013)', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90000)
  await login(page)
  await page.goto('/admin/ai')
  await page.getByTestId('ai-nav-service').click()
  await page.getByRole('button', { name: 'Create service account' }).click()
  await page.getByLabel('Account name').fill('Launch editor')
  const form = page.getByRole('dialog', { name: 'Create service account' })
  const checked = form.getByRole('checkbox', { checked: true })
  await form.getByRole('button', { name: 'Select all capabilities', exact: true }).click()
  await expect(checked).toHaveCount(SERVICE_CAPABILITIES.length)
  await form.getByRole('button', { name: 'Clear all capabilities', exact: true }).click()
  await expect(checked).toHaveCount(0)
  await expect(form.getByRole('button', { name: 'Create account', exact: true })).toBeDisabled()
  await form.getByRole('button', { name: 'Select all Email capabilities', exact: true }).click()
  await expect(checked).toHaveCount(1)
  await expect(form.getByRole('checkbox', { name: /manage email/i })).toBeChecked()
  await form.getByRole('button', { name: 'Clear Email capabilities', exact: true }).click()
  await form.getByRole('checkbox', { name: /view site/i }).check()
  await form.getByRole('checkbox', { name: /create branches/i }).check()
  await form.getByRole('checkbox', { name: /edit site content/i }).check()
  await form.getByRole('button', { name: 'Create account', exact: true }).click()
  await completeStepUp(page)
  const details = page.getByRole('article', { name: 'Account details' })
  await expect(details.getByRole('button', { name: 'Revoke access' })).toBeVisible()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! })
  const copyPrompt = async () => {
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await details.getByRole('button', { name: 'Copy agent prompt' }).click()
    return page.evaluate(() => navigator.clipboard.readText())
  }
  const handoff = await copyPrompt()
  expect(handoff).toContain('ask me for approval')
  await expect(page.getByRole('dialog', { name: 'Agent prompt' })).toHaveCount(0)
  const id = /--account (svc_[a-f0-9-]+)/.exec(handoff)![1]

  // Exercise the shipped CLI in a separate process. Only the OS keyring is
  // replaced so Linux CI needs no desktop keychain and no real keys are written.
  const scratch = testInfo.outputPath('cli')
  await mkdir(scratch, { recursive: true })
  const key = join(scratch, 'temporary-keyring')
  const preload = join(scratch, 'test-keyring.ts')
  await writeFile(preload, `Bun.secrets = {
    set: async ({ value }) => Bun.write(${JSON.stringify(key)}, value, { mode: 0o600 }),
    get: async () => Bun.file(${JSON.stringify(key)}).text(),
  }`)
  const download = /(https?:\/\/[^'\s]+\.tgz)/.exec(handoff)![1]
  const tar = await page.request.get(download)
  expect(tar.ok()).toBe(true)
  const packageFile = join(scratch, 'cli.tgz')
  await writeFile(packageFile, await tar.body())
  await promisify(execFile)('tar', ['-xzf', packageFile, '-C', scratch])
  const cli = ['--preload', preload, join(scratch, 'package/instatic.ts')]
  const options = { env: { ...process.env, INSTATIC_ACCOUNT: id } }
  const run = (...args: string[]) => promisify(execFile)('bun', [...cli, ...args], options)
  const child = spawn('bun', [...cli, 'connect', baseURL!, '--no-open'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const finished = new Promise<number | null>(resolve => child.on('close', resolve))
  try {
    let consentUrl = ''
    for await (const line of createInterface({ input: child.stderr })) {
      if (line.startsWith(baseURL!)) { consentUrl = line; break }
    }
    expect(consentUrl).toContain('/admin/ai/cli/authorize')
    const pairing = new URL(consentUrl)
    expect(pairing.searchParams.get('account')).toBe(id)
    expect(pairing.searchParams.get('challenge')).toHaveLength(43)
    expect(pairing.searchParams.get('state')).toHaveLength(43)
    expect(Number(pairing.searchParams.get('port'))).toBeGreaterThan(0)
    await page.goto(consentUrl)
    expect(new URL(page.url()).search).toBe(pairing.search)
    await expect(page.getByRole('heading', { name: 'Launch editor' })).toBeVisible()
    await page.getByRole('button', { name: 'Authorize CLI' }).click()
    await completeStepUp(page)
    expect(await finished).toBe(0)
    await expect(page).toHaveURL(new RegExp('/admin/ai\\?service-account=' + id))
    await expect(page.getByRole('article', { name: 'Account details' })).toContainText('Connected')
    expect(await copyPrompt()).toBe(handoff)
    const context = JSON.parse((await run('whoami')).stdout)
    expect(context.account).toBe(id)
    expect(context.capabilities.sort()).toEqual(['site.branches.create', 'site.content.edit', 'site.read'])
    expect((await run('api', 'lookup', 'fork')).stdout).toContain('branches')
    const fixture = 'hero-' + Date.now()
    const { site, seq } = await (await page.request.get('/admin/api/cms/site')).json()
    const seed = await page.request.put('/admin/api/cms/site-document', { data: {
      mode: 'incremental', site, shellBaseSeq: seq, baseSeqs: {}, deletedPageIds: [],
      changedComponents: [], deletedComponentIds: [], changedLayouts: [], deletedLayoutIds: [],
      changedPages: [{ id: fixture, slug: fixture, title: 'Launch', rootNodeId: 'body', nodes: {
        body: { id: 'body', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['hero'] },
        hero: { id: 'hero', moduleId: 'base.text', props: { text: 'April launch', tag: 'h1' }, breakpointOverrides: {}, children: [] },
      } }],
    } })
    expect(seed.ok()).toBe(true)
    const branch = 'cli-review-' + Date.now()
    const fork = await run('api', 'POST', 'branches', '--json', JSON.stringify({ name: branch }))
    expect(JSON.parse(fork.stdout).branch.createdByUserId).toBe(id)
    const rows = JSON.parse((await run('api', 'GET', 'pages', '--branch', branch)).stdout).rows
    expect(rows.some((row: { id: string }) => row.id === fixture)).toBe(true)
    const draft = JSON.parse((await run('api', 'GET', 'draft-page/' + fixture, '--branch', branch)).stdout)
    const schema = JSON.parse((await run('api', 'describe', 'PUT', 'site-document')).stdout)
    expect(schema.bodySchema.required).toContain('baseSeqs')
    draft.changedPages[0].nodes.hero.props.text = 'May launch'
    const changeFile = join(scratch, 'change.json')
    await writeFile(changeFile, JSON.stringify(draft))
    await run('api', 'PUT', 'site-document', '--branch', branch, '--file', changeFile)
    const readOn = async (name: string) => JSON.parse((await run('api', 'GET', 'draft-page/' + fixture, '--branch', name)).stdout)
    expect((await readOn(branch)).changedPages[0].nodes.hero.props.text).toBe('May launch')
    expect((await readOn('main')).changedPages[0].nodes.hero.props.text).toBe('April launch')
    const png = join(scratch, 'branch.png')
    await run('screenshot', fixture, '--branch', branch, '--viewport', '390x844', '--out', png)
    const image = await readFile(png)
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([390, 844])
    await page.goto('/admin/ai')
    await page.getByTestId('ai-nav-service').click()
    await page.getByRole('button', { name: 'Launch editor', exact: true }).click()
    await page.getByRole('button', { name: 'Revoke access' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke access' }).click()
    await expect(page.getByRole('row').filter({ hasText: 'Launch editor' }).getByText('Revoked', { exact: true })).toBeVisible()
    await expect(run('whoami')).rejects.toThrow(/401/)
  } finally {
    child.kill()
    await import('node:fs/promises').then(fs => fs.rm(key, { force: true }))
  }
})
