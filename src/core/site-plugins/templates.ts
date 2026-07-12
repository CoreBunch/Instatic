/**
 * Scaffold templates for `New site plugin` — pure data, mirroring the CLI's
 * `instatic-plugin init --kind` shapes. Each template generates the minimal
 * WORKING shape for its kind and pre-declares the matching permissions
 * (declared, not granted — consent still happens at activation). Every
 * template must pass validate-only builds out of the box.
 */
import { sitePluginFolder } from './schemas'

export const SITE_PLUGIN_TEMPLATE_IDS = ['module', 'routes', 'editor', 'empty'] as const
export type SitePluginTemplateId = (typeof SITE_PLUGIN_TEMPLATE_IDS)[number]

export interface SitePluginTemplateInfo {
  id: SitePluginTemplateId
  label: string
  description: string
}

export const SITE_PLUGIN_TEMPLATES: readonly SitePluginTemplateInfo[] = [
  {
    id: 'module',
    label: 'Canvas module',
    description: 'A drag-and-drop canvas block with controls — preview it in the editor without activating.',
  },
  {
    id: 'routes',
    label: 'Backend routes',
    description: 'Server code in the sandbox exposing HTTP routes under the plugin runtime path.',
  },
  {
    id: 'editor',
    label: 'Editor extension',
    description: 'Commands and toolbar buttons inside the admin editor (runs unsandboxed — consent required).',
  },
  {
    id: 'empty',
    label: 'Empty',
    description: 'Just a plugin.json — add folders as you go.',
  },
]

export interface SitePluginTemplateFile {
  path: string
  content: string
}

function manifestJson(name: string, permissions: string[]): string {
  return `${JSON.stringify({ name, description: '', permissions }, null, 2)}\n`
}

export function sitePluginTemplateFiles(
  template: SitePluginTemplateId,
  localId: string,
  name: string,
): SitePluginTemplateFile[] {
  const folder = sitePluginFolder(localId)
  switch (template) {
    case 'module':
      return [
        { path: `${folder}plugin.json`, content: manifestJson(name, ['modules.register']) },
        {
          path: `${folder}modules/${localId}.ts`,
          content: [
            `import { control, defineModule, html } from '@instatic/plugin-sdk'`,
            ``,
            `export default defineModule({`,
            `  id: 'site.${localId}.${localId}',`,
            `  name: '${name}',`,
            `  description: 'Canvas module from the ${name} site plugin.',`,
            `  category: '${name}',`,
            `  htmlTag: 'div',`,
            `  defaults: {`,
            `    message: 'Hello from ${name}.',`,
            `  },`,
            `  schema: {`,
            `    message: control.text('Message'),`,
            `  },`,
            `  render: ({ props }) => ({`,
            `    html: html\`<div class="${localId}">\${props.message}</div>\`,`,
            `    css: \`.${localId} { padding: 12px; border: 1px dashed currentColor; border-radius: 6px; }\`,`,
            `  }),`,
            `})`,
            ``,
          ].join('\n'),
        },
      ]
    case 'routes':
      return [
        { path: `${folder}plugin.json`, content: manifestJson(name, ['cms.routes']) },
        {
          path: `${folder}server/index.ts`,
          content: [
            `/**`,
            ` * Server entrypoint for ${name} — runs inside the QuickJS sandbox.`,
            ` * Routes register under:`,
            ` *   /admin/api/cms/plugins/site.${localId}/runtime/<path>`,
            ` * Call them from browser code via sitePluginRoute('${localId}', '<path>').`,
            ` */`,
            `import type { ServerPluginModule } from '@instatic/plugin-sdk'`,
            ``,
            `const mod: ServerPluginModule = {`,
            `  activate(api) {`,
            `    // Authenticated GET — third argument is the required capability.`,
            `    api.cms.routes.get('/status', 'plugins.read', () => ({`,
            `      ok: true,`,
            `      plugin: api.plugin.id,`,
            `      version: api.plugin.version,`,
            `    }))`,
            `  },`,
            `}`,
            ``,
            `export default mod`,
            ``,
          ].join('\n'),
        },
      ]
    case 'editor':
      return [
        {
          path: `${folder}plugin.json`,
          content: manifestJson(name, ['editor.code', 'editor.commands']),
        },
        {
          path: `${folder}editor/index.ts`,
          content: [
            `/**`,
            ` * Editor entrypoint for ${name} — runs unsandboxed in the admin`,
            ` * window (gated by the editor.code permission at activation).`,
            ` */`,
            `export function activate(api: { editor: { commands: { register(command: { id: string; label: string; run(): unknown }): void } } }) {`,
            `  api.editor.commands.register({`,
            `    id: 'site.${localId}.hello',`,
            `    label: 'Hello from ${name}',`,
            `    run: () => ({ message: 'Hello from ${name}!' }),`,
            `  })`,
            `}`,
            ``,
          ].join('\n'),
        },
      ]
    case 'empty':
      return [{ path: `${folder}plugin.json`, content: manifestJson(name, []) }]
  }
}
