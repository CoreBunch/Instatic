/**
 * Plugin-scope file tools — browser-bridged.
 *
 * All file access goes through the live Plugin IDE session (the CRDT doc is
 * the source of truth while an editor is open): reads return exactly what
 * the user sees — including keystrokes still inside the relay's persist
 * debounce — and writes merge character-level with concurrent human typing
 * instead of clobbering it. The server defines schema + description only;
 * `src/admin/pages/plugins/ide/agent/pluginBridge.ts` applies each call
 * against the IdeCollabSession.
 *
 * Shapes mirror the site code-asset tools: `plugin_read_file` paginates and
 * returns a SHA-256 content hash; `plugin_patch_file` requires the latest
 * `expectedHash` so stale edits fail instead of silently overwriting a
 * peer's (or the user's) newer content.
 *
 * Capability gates mirror the HTTP/relay equivalents: reads need site.read
 * or plugins.read (the IDE list/read surface), writes need `plugins.edit`
 * (the relay's `plugins` write category).
 */
import {
  PluginDeleteFileInputSchema,
  PluginListFilesInputSchema,
  PluginOpenFileInputSchema,
  PluginPatchFileInputSchema,
  PluginReadFileInputSchema,
  PluginRenameFileInputSchema,
  PluginWriteFileInputSchema,
} from '@core/ai'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'

const PLUGIN_READ_CAPS: readonly CoreCapability[] = ['site.read', 'plugins.read']
const PLUGIN_EDIT_CAPS: readonly CoreCapability[] = ['plugins.edit']

const listFilesTool: AiTool = {
  name: 'plugin_list_files',
  scope: 'plugin',
  execution: 'browser',
  requiredCapabilities: PLUGIN_READ_CAPS,
  description:
    'List the open plugin\'s source files from the live IDE session. Returns each file as { fileId, path, size, hash } — paths are relative to the plugin folder (plugin.json, server/index.ts, …). Use the returned hash as expectedHash for plugin_patch_file.',
  inputSchema: PluginListFilesInputSchema,
}

const readFileTool: AiTool = {
  name: 'plugin_read_file',
  scope: 'plugin',
  execution: 'browser',
  requiredCapabilities: PLUGIN_READ_CAPS,
  description:
    'Read one plugin source file by fileId or relative path. Returns the exact content slice, the full-file SHA-256 hash, and pageInfo for pagination. If pageInfo.nextPart is not null, call plugin_read_file again with the same file and part.',
  inputSchema: PluginReadFileInputSchema,
}

const writeFileTool: AiTool = {
  name: 'plugin_write_file',
  scope: 'plugin',
  execution: 'browser',
  requiredCapabilities: PLUGIN_EDIT_CAPS,
  description:
    'Create a new plugin source file, or overwrite an existing one, at a path relative to the plugin folder. Prefer plugin_patch_file for edits to existing files — a whole-file write replaces concurrent edits wholesale. The folder layout is meaningful: server/index.ts becomes the sandboxed backend entrypoint, editor/index.ts the admin editor extension (requires the editor.code permission), modules/*.ts canvas modules (requires modules.register), frontend/ published assets.',
  inputSchema: PluginWriteFileInputSchema,
}

const patchFileTool: AiTool = {
  name: 'plugin_patch_file',
  scope: 'plugin',
  execution: 'browser',
  requiredCapabilities: PLUGIN_EDIT_CAPS,
  description:
    'Patch an existing plugin file by exact text replacement. Requires the latest `expectedHash` from plugin_read_file/plugin_list_files to prevent stale edits. Each replacement\'s oldText must match exactly; if oldText occurs multiple times, make it more specific or set replaceAll:true. Edits merge live with anyone typing in the same file.',
  inputSchema: PluginPatchFileInputSchema,
}

const renameFileTool: AiTool = {
  name: 'plugin_rename_file',
  scope: 'plugin',
  execution: 'browser',
  requiredCapabilities: PLUGIN_EDIT_CAPS,
  description:
    'Rename/move one plugin file to a new path relative to the plugin folder. Renaming across entrypoint folders changes what the build derives (e.g. moving a file into editor/ makes it admin-side code requiring editor.code).',
  inputSchema: PluginRenameFileInputSchema,
}

const deleteFileTool: AiTool = {
  name: 'plugin_delete_file',
  scope: 'plugin',
  execution: 'browser',
  requiredCapabilities: PLUGIN_EDIT_CAPS,
  description:
    'Delete one plugin source file from the live draft (for every editor). plugin.json cannot be deleted — every plugin needs its manifest.',
  inputSchema: PluginDeleteFileInputSchema,
}

const openFileTool: AiTool = {
  name: 'plugin_open_file',
  scope: 'plugin',
  execution: 'browser',
  description:
    'Visibly open a plugin file in the IDE buffer so the user can watch the work. Pure editor-state switch — reading does not require it (plugin_read_file works in the background).',
  inputSchema: PluginOpenFileInputSchema,
}

export const pluginFileTools: AiTool[] = [
  listFilesTool,
  readFileTool,
  writeFileTool,
  patchFileTool,
  renameFileTool,
  deleteFileTool,
  openFileTool,
]

/** Browser-bridged tools that read/navigate but do not change plugin source. */
export const PLUGIN_FILE_READ_ONLY_NAMES = new Set([
  'plugin_list_files',
  'plugin_read_file',
])
