/**
 * Site plugin lifecycle endpoints — scaffold, validate, activation
 * authority (plugins.install + step-up only on consent moments), rebuild
 * skip, grant shrink/grow, and delete (runtime row + draft source).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCapabilityTestHarness,
  expectForbidden,
  expectStepUpRequired,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { getInstalledPlugin } from '../../../server/repositories/plugins'
import type { SitePluginSummary } from '@core/site-plugins'

let harness: CapabilityTestHarness
let uploadsDir: string
let ownerCookie: string
let ownerEmail: string

beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'site-plugin-uploads-'))
  harness = await createCapabilityTestHarness({ uploadsDir })
  ownerCookie = await harness.setupOwner()
  // setupOwner logs in the owner; capture a NON-stepped-up cookie too.
  ownerEmail = ''
})

afterAll(async () => {
  await harness.cleanup()
  await rm(uploadsDir, { recursive: true, force: true })
})

async function updateDraftFile(path: string, content: string): Promise<void> {
  const shell = await getDraftSite(harness.db, MAIN_SCOPE)
  if (!shell) throw new Error('no draft site')
  const files = shell.files.map((file) =>
    file.path === path ? { ...file, content, updatedAt: Date.now() } : file,
  )
  await saveDraftSite(harness.db, MAIN_SCOPE, { ...shell, files, updatedAt: Date.now() })
}

describe('site plugin scaffold + validate', () => {
  test('scaffold requires plugins.edit', async () => {
    // Even a full site editor cannot scaffold — plugin authoring is its own
    // capability, distinct from site-structure rights.
    const viewer = await harness.createRoleUser({
      name: 'Viewer',
      slug: 'viewer',
      capabilities: [
        'plugins.read',
        'site.read',
        'site.structure.edit',
        'site.content.edit',
        'site.style.edit',
      ],
    })
    const res = await harness.cms('/admin/api/cms/site-plugins', {
      method: 'POST',
      cookie: viewer.cookie,
      json: { name: 'Newsletter', localId: 'newsletter', template: 'routes' },
    })
    await expectForbidden(res)
  })

  test('a plugins.edit-only developer can scaffold', async () => {
    const developer = await harness.createRoleUser({
      name: 'Plugin Developer',
      slug: 'plugin-developer',
      capabilities: ['site.read', 'plugins.edit'],
    })
    const res = await harness.cms('/admin/api/cms/site-plugins', {
      method: 'POST',
      cookie: developer.cookie,
      json: { name: 'Dev Probe', localId: 'dev-probe', template: 'empty' },
    })
    expect(res.status).toBe(201)
  })

  test('scaffold creates plugin-typed draft files', async () => {
    const res = await harness.cms('/admin/api/cms/site-plugins', {
      method: 'POST',
      cookie: ownerCookie,
      json: { name: 'Newsletter', localId: 'newsletter', template: 'routes' },
    })
    expect(res.status).toBe(201)
    const shell = await getDraftSite(harness.db, MAIN_SCOPE)
    // Scope to this plugin's folder — the suite scaffolds other plugins too.
    const pluginFiles = (shell?.files ?? []).filter(
      (file) => file.type === 'plugin' && file.path.startsWith('plugins/newsletter/'),
    )
    expect(pluginFiles.map((file) => file.path).sort()).toEqual([
      'plugins/newsletter/plugin.json',
      'plugins/newsletter/server/index.ts',
    ])
  })

  test('duplicate scaffold is a 409', async () => {
    const res = await harness.cms('/admin/api/cms/site-plugins', {
      method: 'POST',
      cookie: ownerCookie,
      json: { name: 'Newsletter', localId: 'newsletter', template: 'empty' },
    })
    expect(res.status).toBe(409)
  })

  test('the scaffolded plugin passes validation with site.read only', async () => {
    const viewer = await harness.createRoleUser({
      name: 'Site Reader',
      slug: 'site-reader',
      capabilities: ['site.read'],
    })
    const res = await harness.cms('/admin/api/cms/site-plugins/newsletter/validate', {
      method: 'POST',
      cookie: viewer.cookie,
    })
    expect(res.status).toBe(200)
    const body = await readJson<{ ok: boolean; diagnostics: string[] }>(res)
    expect(body).toEqual({ ok: true, diagnostics: [] })
  })

  test('the list computes draft-changed for a never-built plugin', async () => {
    const res = await harness.cms('/admin/api/cms/site-plugins', { cookie: ownerCookie })
    expect(res.status).toBe(200)
    const body = await readJson<{ sitePlugins: SitePluginSummary[] }>(res)
    const entry = body.sitePlugins.find((plugin) => plugin.localId === 'newsletter')
    expect(entry?.state).toBe('draft-changed')
    expect(entry?.pluginId).toBe('site.newsletter')
    expect(entry?.activeVersion).toBeNull()
  })
})

describe('site plugin activation authority', () => {
  test('activate without plugins.install is forbidden', async () => {
    const editor = await harness.createRoleUser({
      name: 'Site Editor',
      slug: 'site-editor',
      capabilities: ['site.read', 'site.structure.edit', 'site.content.edit', 'site.style.edit'],
    })
    const res = await harness.cms('/admin/api/cms/site-plugins/newsletter/activate', {
      method: 'POST',
      cookie: editor.cookie,
    })
    await expectForbidden(res)
  })

  test('first activation requires step-up; with step-up it installs', async () => {
    const installer = await harness.createRoleUser({
      name: 'Installer',
      slug: 'installer',
      capabilities: ['plugins.read', 'plugins.install', 'site.read'],
    })

    const noStepUp = await harness.cms('/admin/api/cms/site-plugins/newsletter/activate', {
      method: 'POST',
      cookie: installer.cookie,
    })
    await expectStepUpRequired(noStepUp)

    const stepped = await harness.stepUp(installer.cookie)
    const res = await harness.cms('/admin/api/cms/site-plugins/newsletter/activate', {
      method: 'POST',
      cookie: stepped,
    })
    expect(res.status).toBe(200)
    const body = await readJson<{ plugin: { id: string; version: string; source: string } }>(res)
    expect(body.plugin.id).toBe('site.newsletter')
    expect(body.plugin.version).toStartWith('1.0.1+')
    expect(body.plugin.source).toBe('site-local')

    // Package on disk, byte-compatible layout.
    expect(
      existsSync(join(uploadsDir, 'plugins', 'site.newsletter', body.plugin.version, 'plugin.json')),
    ).toBe(true)
    expect(
      existsSync(join(uploadsDir, 'plugins', 'site.newsletter', body.plugin.version, 'server/index.js')),
    ).toBe(true)
  })

  test('unchanged source activation is a skip', async () => {
    const res = await harness.cms('/admin/api/cms/site-plugins/newsletter/activate', {
      method: 'POST',
      cookie: ownerCookie,
    })
    expect(res.status).toBe(200)
    const body = await readJson<{ skipped?: boolean; plugin: { version: string } }>(res)
    expect(body.skipped).toBe(true)
    expect(body.plugin.version).toStartWith('1.0.1+')
  })

  test('source change without grant change rebuilds WITHOUT step-up (upgrade path)', async () => {
    await updateDraftFile(
      'plugins/newsletter/server/index.ts',
      [
        `import type { ServerPluginModule } from '@instatic/plugin-sdk'`,
        `const mod: ServerPluginModule = {`,
        `  activate(api) {`,
        `    api.cms.routes.get('/status', 'plugins.read', () => ({ ok: true, rev: 2 }))`,
        `  },`,
        `}`,
        `export default mod`,
      ].join('\n'),
    )

    const installer = await harness.createRoleUser({
      name: 'Installer 2',
      slug: 'installer-2',
      capabilities: ['plugins.read', 'plugins.install', 'site.read'],
    })
    // NOT stepped up — same grants, no consent moment.
    const res = await harness.cms('/admin/api/cms/site-plugins/newsletter/activate', {
      method: 'POST',
      cookie: installer.cookie,
    })
    expect(res.status).toBe(200)
    const body = await readJson<{
      plugin: { version: string }
      upgrade?: { fromVersion: string; toVersion: string }
    }>(res)
    expect(body.plugin.version).toStartWith('1.0.2+')
    expect(body.upgrade?.fromVersion).toStartWith('1.0.1+')
    expect(body.upgrade?.toVersion).toStartWith('1.0.2+')
  })

  test('adding a permission requires step-up again; grants follow declarations', async () => {
    const shell = await getDraftSite(harness.db, MAIN_SCOPE)
    const manifestFile = shell?.files.find((file) => file.path === 'plugins/newsletter/plugin.json')
    expect(manifestFile).toBeDefined()
    await updateDraftFile(
      'plugins/newsletter/plugin.json',
      JSON.stringify({
        name: 'Newsletter',
        description: '',
        permissions: ['cms.routes', 'cms.routes.public'],
      }),
    )

    const installer = await harness.createRoleUser({
      name: 'Installer 3',
      slug: 'installer-3',
      capabilities: ['plugins.read', 'plugins.install', 'site.read'],
    })
    const noStepUp = await harness.cms('/admin/api/cms/site-plugins/newsletter/activate', {
      method: 'POST',
      cookie: installer.cookie,
    })
    await expectStepUpRequired(noStepUp)

    const stepped = await harness.stepUp(installer.cookie)
    const res = await harness.cms('/admin/api/cms/site-plugins/newsletter/activate', {
      method: 'POST',
      cookie: stepped,
    })
    expect(res.status).toBe(200)
    const row = await getInstalledPlugin(harness.db, 'site.newsletter')
    expect(row?.kind).toBe('ok')
    if (row?.kind === 'ok') {
      expect(row.plugin.grantedPermissions.sort()).toEqual(['cms.routes', 'cms.routes.public'])
    }
  })

  test('the list reports active after activation, with every retained build', async () => {
    const res = await harness.cms('/admin/api/cms/site-plugins', { cookie: ownerCookie })
    const body = await readJson<{ sitePlugins: SitePluginSummary[] }>(res)
    const entry = body.sitePlugins.find((plugin) => plugin.localId === 'newsletter')
    expect(entry?.state).toBe('active')
    expect(entry?.activeVersion).toStartWith('1.0.3+')
    // Three builds so far, all retained (the policy keeps five), newest first.
    expect(entry?.revisions.map((revision) => revision.version.split('+')[0])).toEqual([
      '1.0.3',
      '1.0.2',
      '1.0.1',
    ])
    for (const revision of entry?.revisions ?? []) {
      expect(revision.builtAt).toBeGreaterThan(0)
    }
  })

  test('rollback targets a retained build; a different grant set steps up', async () => {
    const list = await readJson<{ sitePlugins: SitePluginSummary[] }>(
      await harness.cms('/admin/api/cms/site-plugins', { cookie: ownerCookie }),
    )
    const entry = list.sitePlugins.find((plugin) => plugin.localId === 'newsletter')!
    const target = entry.revisions.find((revision) => revision.version.startsWith('1.0.2+'))!

    const installer = await harness.createRoleUser({
      name: 'Installer 4',
      slug: 'installer-4',
      capabilities: ['plugins.read', 'plugins.install', 'site.read'],
    })

    // An unknown version is refused before anything is touched.
    const bogus = await harness.cms('/admin/api/cms/site-plugins/newsletter/rollback', {
      method: 'POST',
      cookie: installer.cookie,
      json: { version: '1.0.99+deadbeef' },
    })
    expect(bogus.status).toBe(400)

    // 1.0.2 was granted [cms.routes]; the active 1.0.3 holds [cms.routes,
    // cms.routes.public] — a grant change, so the consent moment applies.
    const noStepUp = await harness.cms('/admin/api/cms/site-plugins/newsletter/rollback', {
      method: 'POST',
      cookie: installer.cookie,
      json: { version: target.version },
    })
    await expectStepUpRequired(noStepUp)

    const stepped = await harness.stepUp(installer.cookie)
    const res = await harness.cms('/admin/api/cms/site-plugins/newsletter/rollback', {
      method: 'POST',
      cookie: stepped,
      json: { version: target.version },
    })
    expect(res.status).toBe(200)
    const body = await readJson<{ rolledBackTo: string; plugin: { version: string } }>(res)
    expect(body.rolledBackTo).toBe(target.version)
    expect(body.plugin.version).toBe(target.version)

    const row = await getInstalledPlugin(harness.db, 'site.newsletter')
    expect(row?.kind).toBe('ok')
    if (row?.kind === 'ok') {
      expect(row.plugin.version).toBe(target.version)
      expect(row.plugin.grantedPermissions).toEqual(['cms.routes'])
    }

    // The newer build stays retained: rolling forward is a rollback too.
    const after = await readJson<{ sitePlugins: SitePluginSummary[] }>(
      await harness.cms('/admin/api/cms/site-plugins', { cookie: ownerCookie }),
    )
    const afterEntry = after.sitePlugins.find((plugin) => plugin.localId === 'newsletter')
    expect(afterEntry?.revisions.some((revision) => revision.version.startsWith('1.0.3+'))).toBe(true)
    // The draft still declares cms.routes.public, which the rolled-back
    // grant set lacks: that is a draft change like any other, and the
    // review happens on the next activation click.
    expect(afterEntry?.state).toBe('draft-changed')
    expect(afterEntry?.newPermissions).toEqual(['cms.routes.public'])

    const alreadyActive = await harness.cms('/admin/api/cms/site-plugins/newsletter/rollback', {
      method: 'POST',
      cookie: stepped,
      json: { version: target.version },
    })
    expect(alreadyActive.status).toBe(400)
  })
})

describe('site plugin delete', () => {
  test('delete requires step-up, then removes row + assets + draft source', async () => {
    const noStepUp = await harness.cms('/admin/api/cms/site-plugins/newsletter', {
      method: 'DELETE',
      cookie: await harness.sessionForEmail(ownerEmail || (await ownerEmailOf())),
    })
    await expectStepUpRequired(noStepUp)

    const res = await harness.cms('/admin/api/cms/site-plugins/newsletter', {
      method: 'DELETE',
      cookie: ownerCookie,
    })
    expect(res.status).toBe(200)

    expect(await getInstalledPlugin(harness.db, 'site.newsletter')).toBeNull()
    expect(existsSync(join(uploadsDir, 'plugins', 'site.newsletter'))).toBe(false)
    const shell = await getDraftSite(harness.db, MAIN_SCOPE)
    expect(shell?.files.some((file) => file.path.startsWith('plugins/newsletter/'))).toBe(false)
  })
})

async function ownerEmailOf(): Promise<string> {
  const { rows } = await harness.db<{ email: string }>`
    select email from users order by created_at asc limit 1
  `
  return rows[0]!.email
}
