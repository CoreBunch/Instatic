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
  test.setTimeout(120000)
  await login(page)
  await page.goto('/admin/ai')
  await page.getByRole('tab', { name: 'CLI', exact: true }).click()
  await page.getByRole('button', { name: 'Create CLI connection' }).click()
  await page.getByLabel('Connection name').fill('Launch editor')
  const form = page.getByRole('dialog', { name: 'Create CLI connection' })
  const checked = form.getByRole('checkbox', { checked: true })
  await form.getByRole('button', { name: 'Select all capabilities', exact: true }).click()
  await expect(checked).toHaveCount(DELEGABLE_CAPABILITIES.length)
  await expect(form.getByRole('checkbox', { name: /^manage roles/i })).toBeDisabled()
  await form.getByRole('button', { name: 'Clear all capabilities', exact: true }).click()
  await expect(checked).toHaveCount(0)
  await expect(form.getByRole('button', { name: 'Create connection', exact: true })).toBeDisabled()
  await form.getByRole('button', { name: 'Select all Email capabilities', exact: true }).click()
  await expect(checked).toHaveCount(1)
  await expect(form.getByRole('checkbox', { name: /^manage email/i })).toBeChecked()
  await form.getByRole('button', { name: 'Clear Email capabilities', exact: true }).click()
  await form.getByRole('checkbox', { name: /^view site/i }).check()
  await form.getByRole('checkbox', { name: /^create branches/i }).check()
  await form.getByRole('checkbox', { name: /^edit site content/i }).check()
  await form.getByRole('checkbox', { name: /^browse custom tables/i }).check()
  await form.getByRole('checkbox', { name: /^edit site structure/i }).check()
  await form.getByRole('checkbox', { name: /^export data bundles/i }).check()
  await form.getByRole('checkbox', { name: /^import data bundles/i }).check()
  await form.getByRole('checkbox', { name: /^install or uninstall plugins/i }).check()
  await page.screenshot({ path: testInfo.outputPath('plugin-permission.png'), animations: 'disabled' })
  await form.getByRole('button', { name: 'Create connection', exact: true }).click()
  await completeStepUp(page)
  const details = page.getByRole('article', { name: 'Connection details' })
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
    await expect(page.getByRole('article', { name: 'Connection details' })).toContainText('Connected')
    expect(await copyPrompt()).toBe(handoff)
    const context = JSON.parse((await run('whoami')).stdout)
    expect(context.account).toBe(id)
    expect(context.capabilities.sort()).toEqual(['data.custom.tables.read', 'data.export', 'data.import', 'plugins.install', 'site.branches.create', 'site.content.edit', 'site.read', 'site.structure.edit'])
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
    const collectionSlug = 'walks-' + Date.now()
    const created = await page.request.post('/admin/api/cms/data/tables', { data: {
      name: 'Guided Walks', slug: collectionSlug, kind: 'postType', routeBase: '/' + collectionSlug,
      fields: [{ id: 'starts', label: 'Starts', type: 'date' }],
    } })
    expect(created.ok(), await created.text()).toBe(true)
    const { table } = await created.json()
    for (const [slug, title] of [['marsh', 'Marsh walk'], ['fossils', 'Fossil walk']]) {
      const added = await page.request.post('/admin/api/cms/data/tables/' + table.id + '/rows', { data: {
        cells: { title, slug, starts: '2027-02-07' },
      } })
      expect(added.ok(), await added.text()).toBe(true)
    }
    const { site, seq } = await (await page.request.get('/admin/api/cms/site')).json()
    site.files.push({ id: fixture, path: 'scripts/' + fixture + '.js', type: 'script', createdAt: Date.now(), updatedAt: Date.now(),
      content: "document.addEventListener('input', event => { for (const card of document.querySelectorAll('article')) card.hidden = !card.textContent.includes(event.target.value) })" })
    site.runtime.scripts[fixture] = { enabled: true, runInCanvas: false, format: 'classic', placement: 'body-end', timing: 'dom-ready', scope: { type: 'pages', pageIds: [fixture] }, priority: 0 }
    const seed = await page.request.put('/admin/api/cms/site-document', { data: {
      mode: 'incremental', site, shellBaseSeq: seq, baseSeqs: {}, deletedPageIds: [],
      changedComponents: [], deletedComponentIds: [], changedLayouts: [], deletedLayoutIds: [],
      changedPages: [{ id: fixture, slug: fixture, title: 'Launch', rootNodeId: 'body', nodes: {
        body: { id: 'body', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['hero'] },
        hero: { id: 'hero', moduleId: 'base.text', props: { text: 'April launch', tag: 'h1' }, breakpointOverrides: {}, children: [] },
      } }, { id: fixture + '-detail', slug: fixture + '-detail', title: 'Walk detail', rootNodeId: 'body',
        template: { enabled: true, target: { kind: 'postTypes', tableSlugs: [collectionSlug] }, priority: 10 },
        nodes: {
          body: { id: 'body', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['name'] },
          name: { id: 'name', moduleId: 'base.text', props: { tag: 'h1', text: '{currentEntry.title}' }, breakpointOverrides: {}, children: [] },
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
    const loop = JSON.parse((await run('canvas', 'modules', 'base.loop')).stdout)
    expect(loop.propsSchema.properties.filters).toBeDefined()
    const scoped = (...args: string[]) => run(...args, '--branch', branch)
    const { collection } = JSON.parse((await scoped('api', 'lookup', 'list guided walks')).stdout)
    expect(collection.props).toMatchObject({ filters: { tableId: table.id }, orderBy: 'cell:starts' })
    await expect(scoped('canvas', 'collection', 'posts')).rejects.toThrow(/404/)
    await scoped('canvas', 'edit', fixture, '--revision', after.revision, '--json', JSON.stringify([
      { op: 'insertHtml', parent: 'body', html: '<input type="search" aria-label="Search walks">' },
      { ...collection.edit, parent: 'body' },
    ]))
    const detailPath = '/' + collectionSlug + '/fossils'
    const visit = JSON.parse((await scoped('visit', '/' + fixture, '--viewport', '390x844', '--out', join(scratch, 'visitor.png'),
      '--json', JSON.stringify([{ expectText: 'Marsh walk' }, { fillLabel: 'Search walks', value: 'Fossil' },
        { expectHidden: 'Marsh walk' }, { clickLink: 'Fossil walk' }, { expectPath: detailPath }, { expectText: 'Fossil walk' }]))).stdout)
    expect(visit).toMatchObject({ path: detailPath, stepsPassed: 6, errors: [] })
    await expect(scoped('visit', '/no-such-' + fixture)).rejects.toThrow(/404/)
    const png = join(scratch, 'branch.png')
    await run('screenshot', fixture, '--branch', branch, '--viewport', '390x844', '--out', png)
    const image = await readFile(png)
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([390, 844])
    await page.goto('/admin/ai')
    await page.getByRole('tab', { name: 'CLI', exact: true }).click()
    await page.getByRole('button', { name: 'Launch editor', exact: true }).click()
    await page.getByRole('button', { name: 'Revoke access' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke access' }).click()
    await expect(details).toContainText('Revoked')
    await expect(run('whoami')).rejects.toThrow(/401/)
  } finally {
    child.kill()
    await import('node:fs/promises').then(fs => fs.rm(credentials, { recursive: true, force: true }))
  }
})

test('review a team roster, approve its devices together and end the run (AI-014)', async ({ page, baseURL }) => {
  const { createHash, randomBytes } = await import('node:crypto')
  const base = '/admin/api/cms/service-accounts'
  await login(page)
  const branch = 'cli-team-' + Date.now()
  const fork = await page.request.post('/admin/api/cms/branches', { headers: { origin: baseURL! }, data: { name: branch } })
  expect(fork.ok()).toBe(true)
  await page.goto('/admin/ai?cli')
  await page.getByRole('button', { name: 'Create group' }).click()
  const name = 'Team ' + branch
  await page.getByLabel('Group name').fill(name)
  await page.getByRole('button', { name: 'Use sample team' }).click()
  await page.getByRole('button', { name: 'Create group', exact: true }).click()
  const detail = page.getByRole('article', { name: 'Connection details' })
  await detail.getByRole('button', { name: 'Start run' }).click()
  const form = page.getByRole('dialog', { name: 'Start a team run' })
  await form.getByLabel('Branch', { exact: true }).click()
  await page.getByRole('option', { name: branch, exact: true }).click()
  await form.getByLabel('Task', { exact: true }).fill('Review the homepage together.')
  const created = page.waitForResponse(r => r.url().endsWith('/runs') && r.status() === 201)
  await form.getByRole('button', { name: 'Create run' }).click()
  await completeStepUp(page)
  const { run, invites } = await (await created).json()
  const devices = invites.map((invite: { accountId: string; enrollmentKey: string }) => {
    const verifier = randomBytes(32).toString('base64url')
    return { ...invite, verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
  })
  const anonymous = await page.context().browser()!.newContext({ baseURL })
  try {
    for (const device of devices) {
      const res = await anonymous.request.post(base + '/' + device.accountId + '/enroll', { headers: { origin: baseURL! },
        data: { runId: run.id, enrollmentKey: device.enrollmentKey, challenge: device.challenge } })
      expect(res.ok()).toBe(true)
    }
    await detail.getByRole('button', { name: /Review requests/ }).click()
    const consent = page.getByRole('dialog', { name: 'Approve team access' })
    for (const device of devices) await expect(consent.getByText(device.challenge.slice(0, 8), { exact: true })).toBeVisible({ timeout: 15000 })
    await consent.getByRole('button', { name: 'Approve 3 agents' }).click()
    await completeStepUp(page)
    const tokens: string[] = []
    for (const device of devices) {
      const result = await anonymous.request.post(base + '/' + device.accountId + '/poll', {
        headers: { origin: baseURL! }, data: { verifier: device.verifier } })
      expect(result.status()).toBe(200)
      const { token } = await result.json()
      tokens.push(token)
      const review = await anonymous.request.get('/admin/api/cms/branches/' + branch + '/review',
        { headers: { authorization: 'Bearer ' + token, 'X-Instatic-Branch': branch } })
      expect(review.ok()).toBe(true)
    }
    await expect(detail.getByText('Read the branch review', { exact: true })).toHaveCount(3, { timeout: 15000 })
    for (const title of ['Activity', 'Access', 'Agents']) await expect(detail.getByRole('heading', { name: title, exact: true })).toBeVisible()
    for (const title of ['Open branch review', 'Edit group', 'End run']) {
      const action = detail.getByRole('button', { name: title, exact: true })
      await expect(action).toBeVisible()
      await expect(action).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
    await detail.getByRole('button', { name: 'End run' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'End run' }).click()
    await expect(detail).toContainText('Run ended')
    for (const token of tokens) {
      expect((await anonymous.request.get('/admin/api/cms/cli-context', { headers: { authorization: 'Bearer ' + token } })).status()).toBe(401)
    }
  } finally { await anonymous.close() }
})
