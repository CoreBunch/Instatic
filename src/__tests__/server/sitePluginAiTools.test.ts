/**
 * Plugin-scope AI tools — selection-time capability filtering and the
 * server-resolved lifecycle handlers (`plugin_validate`, `plugin_activate`,
 * `plugin_list_plugins`).
 *
 * The activation consent invariant under test: the agent may rebuild
 * same-grant revisions autonomously, but any grant-set change (including
 * the first activation) is refused with an instruction to confirm in the
 * IDE header — the tool path can never replace the human step-up.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreCapability } from '@core/capabilities'
import type { AiToolOutput } from '@core/ai'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import { selectToolsForScope } from '../../../server/ai/tools'
import { pluginTools } from '../../../server/ai/tools/plugin'
import type { AiTool, ToolContext } from '../../../server/ai/runtime/types'

let harness: CapabilityTestHarness
let uploadsDir: string
let ownerCookie: string
let ownerId: string

beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'site-plugin-ai-uploads-'))
  harness = await createCapabilityTestHarness({ uploadsDir })
  ownerCookie = await harness.setupOwner()
  const me = await harness.cms('/admin/api/cms/me', { cookie: ownerCookie })
  ownerId = (await readJson<{ user: { id: string } }>(me)).user.id
})

afterAll(async () => {
  await harness.cleanup()
  await rm(uploadsDir, { recursive: true, force: true })
})

function toolByName(name: string): AiTool {
  const tool = pluginTools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`no plugin tool named ${name}`)
  return tool
}

function ctx(capabilities: CoreCapability[], snapshot: unknown = null): ToolContext {
  return {
    db: harness.db,
    userId: ownerId,
    capabilities,
    scope: 'plugin',
    conversationId: 'test',
    snapshot,
    uploadsDir,
    signal: new AbortController().signal,
  }
}

const OWNER_CAPS: CoreCapability[] = [
  'site.read',
  'plugins.read',
  'plugins.edit',
  'plugins.install',
  'ai.chat',
  'ai.tools.write',
]

async function run(name: string, input: unknown, context: ToolContext): Promise<AiToolOutput> {
  const tool = toolByName(name)
  return (await tool.handler!(input, context)) as AiToolOutput
}

describe('plugin toolset selection', () => {
  test('a reader sees read tools only', () => {
    const offered = selectToolsForScope('plugin', ['ai.chat', 'site.read'])
    const names = offered.map((tool) => tool.name).sort()
    expect(names).toEqual(['plugin_list_files', 'plugin_list_plugins', 'plugin_read_file', 'plugin_validate'])
  })

  test('write tools require ai.tools.write AND plugins.edit', () => {
    const withoutEdit = selectToolsForScope('plugin', ['ai.chat', 'ai.tools.write', 'site.read'])
    expect(withoutEdit.some((tool) => tool.name === 'plugin_write_file')).toBe(false)
    // plugin_open_file is a pure editor-state switch — write-flag gated only.
    expect(withoutEdit.some((tool) => tool.name === 'plugin_open_file')).toBe(true)

    const withEdit = selectToolsForScope('plugin', ['ai.chat', 'ai.tools.write', 'plugins.edit'])
    const names = withEdit.map((tool) => tool.name)
    expect(names).toContain('plugin_write_file')
    expect(names).toContain('plugin_patch_file')
    expect(names).toContain('plugin_rename_file')
    expect(names).toContain('plugin_delete_file')
    // …but not activate (plugins.install) or the site.read-gated reads.
    expect(names).not.toContain('plugin_activate')
  })

  test('plugin_activate requires plugins.install', () => {
    const installer = selectToolsForScope('plugin', ['ai.chat', 'ai.tools.write', 'plugins.install'])
    expect(installer.some((tool) => tool.name === 'plugin_activate')).toBe(true)
  })
})

describe('plugin lifecycle tool handlers', () => {
  test('plugin_validate validates a scaffolded plugin (explicit localId)', async () => {
    const scaffold = await harness.cms('/admin/api/cms/site-plugins', {
      method: 'POST',
      cookie: ownerCookie,
      json: { name: 'Agent Probe', localId: 'agent-probe', template: 'routes' },
    })
    expect(scaffold.status).toBe(201)

    const result = await run('plugin_validate', { localId: 'agent-probe' }, ctx(OWNER_CAPS))
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ ok: true, diagnostics: [] })
  })

  test('plugin_validate resolves the open plugin from the snapshot', async () => {
    const snapshot = {
      localId: 'agent-probe',
      pluginId: 'site.agent-probe',
      files: [],
      activeFile: null,
      state: 'draft-changed',
      activeVersion: null,
      declaredPermissions: [],
      grantedPermissions: [],
      latestDiagnostics: null,
      currentUser: { id: ownerId, displayName: 'Owner', email: 'o@example.com' },
    }
    const result = await run('plugin_validate', {}, ctx(OWNER_CAPS, snapshot))
    expect(result.ok).toBe(true)
  })

  test('plugin_validate without any plugin in scope names the fix', async () => {
    const result = await run('plugin_validate', {}, ctx(OWNER_CAPS))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('plugin_list_plugins')
  })

  test('first activation is a consent moment — the tool refuses', async () => {
    const result = await run('plugin_activate', { localId: 'agent-probe' }, ctx(OWNER_CAPS))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('human consent')
    expect(result.error).toContain('Build & activate')
  })

  test('same-grant rebuild activates without consent friction', async () => {
    // Human first-activation via the HTTP route (step-up cookie from setupOwner).
    const httpActivate = await harness.cms('/admin/api/cms/site-plugins/agent-probe/activate', {
      method: 'POST',
      cookie: ownerCookie,
    })
    expect(httpActivate.status).toBe(200)

    // Change the source (same grants), then the agent rebuilds autonomously.
    const shell = await getDraftSite(harness.db)
    if (!shell) throw new Error('no draft')
    const files = shell.files.map((file) =>
      file.path === 'plugins/agent-probe/server/index.ts'
        ? { ...file, content: `${file.content}\n// agent edit`, updatedAt: Date.now() }
        : file,
    )
    await saveDraftSite(harness.db, { ...shell, files, updatedAt: Date.now() })

    const result = await run('plugin_activate', { localId: 'agent-probe' }, ctx(OWNER_CAPS))
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ activated: true, pluginId: 'site.agent-probe' })
  })

  test('unchanged source re-activation is a skip', async () => {
    const result = await run('plugin_activate', { localId: 'agent-probe' }, ctx(OWNER_CAPS))
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ activated: false, skipped: true })
  })

  test('plugin_list_plugins reports the runtime state', async () => {
    const result = await run('plugin_list_plugins', {}, ctx(OWNER_CAPS))
    expect(result.ok).toBe(true)
    const { sitePlugins } = result.data as { sitePlugins: Array<{ localId: string; state: string }> }
    const entry = sitePlugins.find((plugin) => plugin.localId === 'agent-probe')
    expect(entry?.state).toBe('active')
  })
})
