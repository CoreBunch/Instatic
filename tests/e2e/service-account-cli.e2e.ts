import { DELEGABLE_CAPABILITIES } from '../../src/core/capabilities'
import { zipSync, strToU8 } from 'fflate'
import { expect, test } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { mkdir, writeFile, readFile, stat, chmod, symlink, unlink } from 'node:fs/promises'
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
  await expect(checked).toHaveCount(DELEGABLE_CAPABILITIES.length)
  await expect(form.getByRole('checkbox', { name: /^manage roles/i })).toBeDisabled()
  await form.getByRole('button', { name: 'Clear all capabilities', exact: true }).click()
  await expect(checked).toHaveCount(0)
  await expect(form.getByRole('button', { name: 'Create account', exact: true })).toBeDisabled()
  await form.getByRole('button', { name: 'Select all Email capabilities', exact: true }).click()
  await expect(checked).toHaveCount(1)
  await expect(form.getByRole('checkbox', { name: /^manage email/i })).toBeChecked()
  await form.getByRole('button', { name: 'Clear Email capabilities', exact: true }).click()
  await form.getByRole('checkbox', { name: /^view site/i }).check()
  await form.getByRole('checkbox', { name: /^create branches/i }).check()
  await form.getByRole('checkbox', { name: /^edit site content/i }).check()
  await form.getByRole('checkbox', { name: /^export data bundles/i }).check()
  await form.getByRole('checkbox', { name: /^import data bundles/i }).check()
  await form.getByRole('checkbox', { name: /^install or uninstall plugins/i }).check()
  await page.screenshot({ path: testInfo.outputPath('plugin-permission.png'), animations: 'disabled' })
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
  expect(handoff).toContain('instatic api describe METHOD PATH')
  await expect(page.getByRole('dialog', { name: 'Agent prompt' })).toHaveCount(0)
  const id = /--account (svc_[a-f0-9-]+)/.exec(handoff)![1]

  const scratch = testInfo.outputPath('cli')
  await mkdir(scratch, { recursive: true })
  const credentials = join(scratch, 'credentials')
  const download = /(https?:\/\/[^'\s]+\.tgz)/.exec(handoff)![1]
  const tar = await page.request.get(download)
  expect(tar.ok()).toBe(true)
  const packageFile = join(scratch, 'cli.tgz')
  await writeFile(packageFile, await tar.body())
  await promisify(execFile)('tar', ['-xzf', packageFile, '-C', scratch])
  const cli = [join(scratch, 'package/instatic.ts')]
  const options = { env: { ...process.env, INSTATIC_ACCOUNT: id, INSTATIC_CREDENTIAL_DIR: credentials } }
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
    const file = join(credentials, id + '.json')
    if (process.platform !== 'win32') {
      expect((await stat(credentials)).mode & 0o777).toBe(0o700)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      await chmod(file, 0o644)
      await expect(run('whoami')).rejects.toThrow('private to the current user')
      await chmod(file, 0o600)
      const alias = 'svc_00000000-0000-0000-0000-000000000000'
      const link = join(credentials, alias + '.json')
      await symlink(file, link)
      await expect(run('whoami', '--account', alias)).rejects.toThrow()
      await unlink(link)
    }
    const { guide, operations } = JSON.parse((await run('api', 'lookup', 'member')).stdout)
    expect(guide.task).toContain('membership')
    expect(operations).toEqual(expect.any(Array))
    await expect(page).toHaveURL(new RegExp('/admin/ai\\?service-account=' + id))
    await expect(page.getByRole('article', { name: 'Account details' })).toContainText('Connected')
    expect(await copyPrompt()).toBe(handoff)
    const context = JSON.parse((await run('whoami')).stdout)
    expect(context.account).toBe(id)
    expect(context.capabilities.sort()).toEqual(['data.export', 'data.import', 'plugins.install', 'site.branches.create', 'site.content.edit', 'site.read'])
    const [forkOperation] = JSON.parse((await run('api', 'lookup', 'fork')).stdout)
    const forkContract = JSON.parse((await run('api', 'describe', forkOperation.method, forkOperation.path)).stdout)
    expect(forkContract.bodySchema.required).toContain('name')
    expect((await run('api', 'lookup', 'plugins/package')).stdout).toContain('grantedPermissions')
    const pluginId = 'test.cli-' + Date.now()
    const manifest = { id: pluginId, name: 'CLI plugin', apiVersion: 1, version: '1.0.0', permissions: ['cms.routes'], entrypoints: { server: 'server.js' } }
    const zip = join(scratch, 'plugin.zip')
    const server = `export function activate(api) {
      api.cms.routes.get('/status', 'site.read', () => ({ ok: true }), { summary: 'Read plugin status', input: 'No query parameters or body.' })
      api.cms.routes.get('/restricted', 'plugins.lifecycle', () => ({ ok: true }))
    }`
    await writeFile(zip, zipSync({ 'plugin.json': strToU8(JSON.stringify(manifest)), 'server.js': strToU8(server) }))
    const inspect = await run('api', 'POST', 'plugins/inspect-package', '--upload', zip)
    expect(JSON.parse(inspect.stdout).manifest.permissions).toEqual(manifest.permissions)
    await expect(run('api', 'POST', 'plugins/package', '--upload', zip)).rejects.toThrow(/permission grants/)
    const install = await run('api', 'POST', 'plugins/package', '--upload', zip, '--field', 'grantedPermissions=["cms.routes"]')
    expect(JSON.parse(install.stdout).plugin.id).toBe(pluginId)
    const runtimePath = 'plugins/' + pluginId + '/runtime/status'
    const discovered = JSON.parse((await run('api', 'lookup', pluginId)).stdout)
    expect(discovered.map((op: { method: string }) => op.method).sort()).toEqual(['GET', 'HEAD'])
    expect(discovered[0].path).toBe(runtimePath)
    expect((await run('api', 'lookup', pluginId)).stdout).not.toContain('/restricted')
    const runtime = JSON.parse((await run('api', 'describe', 'GET', runtimePath)).stdout)
    expect(JSON.parse((await run('api', 'HEAD', runtimePath)).stdout)['content-type']).toContain('json')
    expect(runtime.pluginInput).toBe('No query parameters or body.')
    expect(JSON.parse((await run('api', 'GET', runtimePath)).stdout)).toEqual({ ok: true })
    const preview = JSON.parse((await run('api', 'describe', 'GET', 'branches/:id/review/render')).stdout)
    expect(preview.querySchema.required.sort()).toEqual(['row', 'side'])
    const inputs = JSON.parse((await run('api', 'describe', 'POST', '/admin/api/cms/plugins/package')).stdout)
    expect(inputs.multipart.grantedPermissions).toContain('JSON array')
    await expect(run('api', 'describe', 'PATCH', 'plugins/:id')).rejects.toThrow(/404/)
    await page.goto('/admin/plugins')
    await expect(page.getByRole('heading', { name: manifest.name, exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('cli-installed-plugin.png') })
    await expect(run('api', 'PATCH', 'plugins/' + pluginId, '--json', '{"enabled":false}')).rejects.toThrow(/403/)
    await run('api', 'DELETE', 'plugins/' + pluginId)
    await expect(run('api', 'describe', 'GET', runtimePath)).rejects.toThrow(/404/)
    const bundle = join(scratch, 'export.zip')
    await run('api', 'GET', 'export', '--out', bundle)
    expect((await readFile(bundle)).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    await expect(run('api', 'POST', 'import/archive?strategy=replace', '--raw', bundle)).rejects.toThrow(/403/)
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
    const fork = await run('api', forkContract.method, forkContract.path, '--json', JSON.stringify({ ...forkContract.example, name: branch }))
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
    const inspectHero = async (label: string) => JSON.parse((await run('canvas', 'inspect', fixture, '--branch', branch,
      '--viewport', '390x844', '--node', 'hero', '--out', join(scratch, label + '.png'))).stdout)
    const before = await inspectHero('before')
    expect(before.nodes).toContainEqual(expect.objectContaining({ node: 'hero', text: 'May launch' }))
    const change = await run('canvas', 'edit', fixture, '--branch', branch, '--revision', before.revision,
      '--json', JSON.stringify([{ op: 'text', node: 'hero', value: 'Summer launch' }]))
    expect(JSON.parse(change.stdout).changes[0]).toMatchObject({ before: 'May launch', after: 'Summer launch' })
    const after = await inspectHero('after')
    expect(after.revision).not.toBe(before.revision)
    expect(after.nodes[0].text).toBe('Summer launch')
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
    await import('node:fs/promises').then(fs => fs.rm(credentials, { recursive: true, force: true }))
  }
})
