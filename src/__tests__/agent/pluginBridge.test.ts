/**
 * Plugin-scope browser bridge — the dispatcher that turns `plugin_*` tool
 * requests into operations on the live IDE session.
 *
 * Runs against a Y.Text-backed fake of IdeCollabSession + a registered
 * bridge handle, so it exercises the real path/hash/patch logic without a
 * socket. Invariants: paths never escape the plugin folder, plugin.json is
 * rename/delete-protected, patches are hash-guarded, and writes without
 * plugins.edit are refused.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { executePluginTool } from '../../admin/pages/plugins/ide/agent/pluginBridge'
import {
  setPluginIdeBridgeHandle,
  type PluginIdeBridgeHandle,
} from '../../admin/pages/plugins/ide/agent/pluginBridgeHandle'
import type { IdeCollabSession, IdeFileMeta } from '../../admin/pages/plugins/ide/ideCollab'

const FOLDER = 'plugins/probe/'

interface FakeIde {
  session: IdeCollabSession
  handle: PluginIdeBridgeHandle
  metas: IdeFileMeta[]
  contentOf(fileId: string): string
  selected: string[]
  canEdit: boolean
}

function createFakeIde(seed: Record<string, string>): FakeIde {
  const doc = new Y.Doc()
  const texts = new Map<string, Y.Text>()
  const metas: IdeFileMeta[] = []
  let counter = 0

  const addFile = (path: string, content: string): string => {
    const id = `f${++counter}`
    const text = new Y.Text()
    doc.getMap('files').set(id, text as unknown as Y.Map<unknown>)
    text.insert(0, content)
    texts.set(id, text)
    metas.push({ id, path, updatedAt: 0 })
    return id
  }
  for (const [relative, content] of Object.entries(seed)) {
    addFile(`${FOLDER}${relative}`, content)
  }

  const state: { selected: string[]; canEdit: boolean } = { selected: [], canEdit: true }

  const session = {
    contentText: (fileId: string) => texts.get(fileId) ?? null,
    createFile: (path: string, content?: string) => addFile(path, content ?? ''),
    renameFile: (fileId: string, nextPath: string) => {
      const meta = metas.find((entry) => entry.id === fileId)
      if (meta) meta.path = nextPath
    },
    deleteFile: (fileId: string) => {
      const index = metas.findIndex((entry) => entry.id === fileId)
      if (index >= 0) metas.splice(index, 1)
      texts.delete(fileId)
    },
    replaceFileContent: (fileId: string, content: string) => {
      const text = texts.get(fileId)
      if (!text) return
      text.delete(0, text.length)
      text.insert(0, content)
    },
  } as unknown as IdeCollabSession

  const handle: PluginIdeBridgeHandle = {
    localId: 'probe',
    buildSnapshot: () => {
      throw new Error('not used by the dispatcher')
    },
    session: () => session,
    files: () => metas,
    selectFile: (fileId) => state.selected.push(fileId),
    canEdit: () => state.canEdit,
  }

  return {
    session,
    handle,
    metas,
    contentOf: (fileId) => texts.get(fileId)?.toString() ?? '',
    get selected() {
      return state.selected
    },
    set canEdit(value: boolean) {
      state.canEdit = value
    },
    get canEdit() {
      return state.canEdit
    },
  }
}

let ide: FakeIde

beforeEach(() => {
  ide = createFakeIde({
    'plugin.json': '{\n  "name": "Probe"\n}\n',
    'server/index.ts': 'export const handler = () => new Response("v1")\n',
  })
  setPluginIdeBridgeHandle(ide.handle)
})

afterEach(() => {
  setPluginIdeBridgeHandle(null)
})

async function readHash(path: string): Promise<string> {
  const read = await executePluginTool('plugin_read_file', { path })
  expect(read.ok).toBe(true)
  return (read.data as { hash: string }).hash
}

describe('plugin bridge dispatcher', () => {
  test('list + read return relative paths and stable hashes', async () => {
    const list = await executePluginTool('plugin_list_files', {})
    expect(list.ok).toBe(true)
    const files = (list.data as { files: Array<{ path: string; hash: string }> }).files
    expect(files.map((file) => file.path).sort()).toEqual(['plugin.json', 'server/index.ts'])

    const read = await executePluginTool('plugin_read_file', { path: 'server/index.ts' })
    expect(read.ok).toBe(true)
    const data = read.data as { content: string; hash: string; pageInfo: { nextPart: number | null } }
    expect(data.content).toContain('v1')
    expect(data.pageInfo.nextPart).toBeNull()
    expect(files.find((file) => file.path === 'server/index.ts')?.hash).toBe(data.hash)
  })

  test('write creates new files and overwrites existing ones', async () => {
    const created = await executePluginTool('plugin_write_file', {
      path: 'editor/index.ts',
      content: 'export {}\n',
    })
    expect(created.ok).toBe(true)
    expect((created.data as { created: boolean }).created).toBe(true)
    expect(ide.metas.some((meta) => meta.path === `${FOLDER}editor/index.ts`)).toBe(true)

    const overwritten = await executePluginTool('plugin_write_file', {
      path: 'editor/index.ts',
      content: 'export const x = 1\n',
    })
    expect(overwritten.ok).toBe(true)
    expect((overwritten.data as { created: boolean }).created).toBe(false)
  })

  test('patch applies exact replacements behind the hash guard', async () => {
    const hash = await readHash('server/index.ts')
    const patched = await executePluginTool('plugin_patch_file', {
      path: 'server/index.ts',
      expectedHash: hash,
      replacements: [{ oldText: '"v1"', newText: '"v2"' }],
    })
    expect(patched.ok).toBe(true)
    const meta = ide.metas.find((entry) => entry.path === `${FOLDER}server/index.ts`)!
    expect(ide.contentOf(meta.id)).toContain('v2')

    // The old hash is now stale — a second patch with it must refuse.
    const stale = await executePluginTool('plugin_patch_file', {
      path: 'server/index.ts',
      expectedHash: hash,
      replacements: [{ oldText: '"v2"', newText: '"v3"' }],
    })
    expect(stale.ok).toBe(false)
    expect(stale.error).toContain('Hash mismatch')
  })

  test('ambiguous replacements require replaceAll', async () => {
    await executePluginTool('plugin_write_file', { path: 'notes.ts', content: 'aa aa\n' })
    const hash = await readHash('notes.ts')
    const ambiguous = await executePluginTool('plugin_patch_file', {
      path: 'notes.ts',
      expectedHash: hash,
      replacements: [{ oldText: 'aa', newText: 'bb' }],
    })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.error).toContain('replaceAll')

    const all = await executePluginTool('plugin_patch_file', {
      path: 'notes.ts',
      expectedHash: hash,
      replacements: [{ oldText: 'aa', newText: 'bb', replaceAll: true }],
    })
    expect(all.ok).toBe(true)
  })

  test('paths cannot escape the plugin folder', async () => {
    for (const path of ['../evil.ts', '/etc/passwd', 'a/../../evil.ts']) {
      const result = await executePluginTool('plugin_write_file', { path, content: 'x' })
      expect(result.ok, `path "${path}" must be rejected`).toBe(false)
    }
  })

  test('plugin.json is rename- and delete-protected', async () => {
    const del = await executePluginTool('plugin_delete_file', { path: 'plugin.json' })
    expect(del.ok).toBe(false)
    expect(del.error).toContain('manifest')

    const rename = await executePluginTool('plugin_rename_file', {
      path: 'plugin.json',
      newPath: 'manifest.json',
    })
    expect(rename.ok).toBe(false)

    // Ordinary files rename + delete fine.
    const ok = await executePluginTool('plugin_rename_file', {
      path: 'server/index.ts',
      newPath: 'server/main.ts',
    })
    expect(ok.ok).toBe(true)
    const gone = await executePluginTool('plugin_delete_file', { path: 'server/main.ts' })
    expect(gone.ok).toBe(true)
  })

  test('open_file switches the visible buffer', async () => {
    const result = await executePluginTool('plugin_open_file', { path: 'plugin.json' })
    expect(result.ok).toBe(true)
    expect(ide.selected).toHaveLength(1)
  })

  test('writes are refused without plugins.edit; reads still work', async () => {
    ide.canEdit = false
    const write = await executePluginTool('plugin_write_file', { path: 'x.ts', content: '' })
    expect(write.ok).toBe(false)
    expect(write.error).toContain('plugins.edit')
    const read = await executePluginTool('plugin_read_file', { path: 'plugin.json' })
    expect(read.ok).toBe(true)
  })

  test('a closed IDE yields an actionable error', async () => {
    setPluginIdeBridgeHandle(null)
    const result = await executePluginTool('plugin_list_files', {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('/admin/plugins/develop')
  })
})
