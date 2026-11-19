/**
 * `instatic-plugin init <name>` — scaffold a new plugin project.
 *
 * Creates a minimal but real plugin: one canvas module, a settings entry,
 * and a `instatic-plugin.config.ts` that uses the SDK builders. The author can
 * `cd <name>` and run `instatic-plugin dev` immediately.
 *
 * Convention: `<name>` becomes the plugin id `<vendor>.<short>`. We split
 * on the first `.` so `acme.confetti` → directory `confetti`, plugin id
 * stays as-given. A short name without a dot becomes
 * `local.<short>` to enforce the namespace requirement.
 *
 * The packaged CLI also writes a `package.json` and a `tsconfig.json`, so
 * the scaffold is a project that installs and typechecks by itself. Run
 * from source inside the Instatic checkout it leaves both out (see
 * `sdkPackage.ts` for why).
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SDK_PACKAGE_NAME, SDK_PACKAGE_VERSION, sdkTarballUrl } from './sdkPackage'

export type InitKind = 'module' | 'content-editor'

interface InitTemplate {
  pluginId: string
  pluginName: string
  packageName: string
  kind: InitKind
}

function pluginIdFromName(input: string): { pluginId: string; pluginName: string; dirName: string } {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Plugin name is required: `instatic-plugin init <name>`')
  }
  const safeId = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!safeId) {
    throw new Error(`Cannot derive a plugin id from "${input}"`)
  }
  const pluginId = safeId.includes('.') ? safeId : `local.${safeId}`
  const dirName = pluginId.split('.').slice(1).join('-') || pluginId
  const pluginName = capitaliseWords(dirName)
  return { pluginId, pluginName, dirName }
}

function capitaliseWords(input: string): string {
  return input
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export interface RunPluginInitOptions {
  kind?: InitKind
  parentDir?: string
}

export async function runPluginInit(
  rawName: string,
  options: RunPluginInitOptions = {},
): Promise<string> {
  const { kind = 'module', parentDir = process.cwd() } = options
  const { pluginId, pluginName, dirName } = pluginIdFromName(rawName)
  const pluginDir = resolve(parentDir, dirName)

  if (existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}`)
  }

  const template: InitTemplate = {
    pluginId,
    pluginName,
    packageName: dirName,
    kind,
  }

  if (kind === 'content-editor') {
    await mkdir(join(pluginDir, 'server'), { recursive: true })
    await writeFile(join(pluginDir, 'instatic-plugin.config.ts'), pluginConfigTemplate(template), 'utf-8')
    await writeFile(join(pluginDir, 'server', 'index.ts'), serverEntryTemplate(template), 'utf-8')
    await writeSharedFiles(pluginDir, template)
    return pluginDir
  }

  await mkdir(join(pluginDir, 'modules'), { recursive: true })
  await writeFile(join(pluginDir, 'instatic-plugin.config.ts'), pluginConfigTemplate(template), 'utf-8')
  await writeFile(join(pluginDir, 'modules', 'hello.ts'), helloModuleTemplate(template), 'utf-8')
  await writeSharedFiles(pluginDir, template)

  return pluginDir
}

async function writeSharedFiles(pluginDir: string, template: InitTemplate): Promise<void> {
  await writeFile(join(pluginDir, 'README.md'), readmeTemplate(template), 'utf-8')
  await writeFile(join(pluginDir, '.gitignore'), gitignoreTemplate(), 'utf-8')
  if (SDK_PACKAGE_VERSION === null) return
  await writeFile(
    join(pluginDir, 'package.json'),
    packageJsonTemplate(template, SDK_PACKAGE_VERSION),
    'utf-8',
  )
  await writeFile(join(pluginDir, 'tsconfig.json'), tsconfigTemplate(), 'utf-8')
}

/**
 * The SDK is pinned to the exact version of the CLI that scaffolds the
 * plugin: each SDK version is built from the Instatic release with the same
 * number, so the pin names the CMS the plugin is written for.
 */
function packageJsonTemplate({ packageName }: InitTemplate, sdkVersion: string): string {
  const manifest = {
    name: packageName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'instatic-plugin dev',
      build: 'instatic-plugin build',
      lint: 'instatic-plugin lint',
      typecheck: 'tsc --noEmit',
    },
    devDependencies: {
      [SDK_PACKAGE_NAME]: sdkVersion,
      typescript: '^6.0.0',
    },
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * `moduleResolution: bundler` matches how the CLI bundles the plugin and is
 * what the SDK's declaration files are written for. `skipLibCheck` keeps the
 * typecheck on the plugin's own code: the SDK's editor types mention host
 * libraries a plugin does not install. The `types` entry declares the
 * `@instatic/host-ui` and `@instatic/host-hooks` modules the host supplies
 * at runtime.
 */
function tsconfigTemplate(): string {
  const tsconfig = {
    compilerOptions: {
      target: 'es2023',
      lib: ['ES2023', 'DOM'],
      module: 'esnext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [`${SDK_PACKAGE_NAME}/host`],
    },
    include: ['**/*.ts', '**/*.tsx'],
    exclude: ['node_modules', 'dist'],
  }
  return `${JSON.stringify(tsconfig, null, 2)}\n`
}

function pluginConfigTemplate(template: InitTemplate): string {
  if (template.kind === 'content-editor') {
    return contentEditorPluginConfigTemplate(template)
  }
  const { pluginId, pluginName } = template
  return `import { definePlugin, permissions } from '@instatic/plugin-sdk'
import hello from './modules/hello'

export default definePlugin({
  id: '${pluginId}',
  name: '${pluginName}',
  version: '0.1.0',
  description: 'A new ${pluginName} plugin.',
  permissions: [permissions.modulesRegister],
  modules: [hello],
  // Add settings, admin pages, hooks, frontend bundles, or a Visual Component
  // pack here as your plugin grows. See docs/features/plugin-system.md for the
  // full SDK surface.
})
`
}

function contentEditorPluginConfigTemplate({ pluginId, pluginName }: InitTemplate): string {
  return `import { definePlugin, permissions } from '@instatic/plugin-sdk'

export default definePlugin({
  id: '${pluginId}',
  name: '${pluginName}',
  version: '0.1.0',
  description: 'A ${pluginName} content-editor plugin (reads + writes CMS entries).',

  permissions: [
    permissions.cmsHooks,
    permissions.cmsContentRead,
    permissions.cmsContentWrite,
  ],

  // Per-table allowlist for the cms.content.* surface — the operator can
  // review exactly which tables your plugin touches before installing.
  // Declare concrete slugs, or '@own-created' to cover tables your plugin
  // creates at runtime via api.cms.content.tables.create(...).
  contentAccess: [
    { table: 'pages', modes: ['read', 'write'] },
  ],

  // No entrypoints here — \`instatic-plugin build\` auto-wires
  // \`entrypoints.server\` because \`server/index.ts\` exists.
})
`
}

function serverEntryTemplate({ pluginName }: InitTemplate): string {
  return `import type { ServerPluginModule } from '@instatic/plugin-sdk'

/**
 * Server entrypoint for ${pluginName}.
 *
 * Demonstrates a typical content-editor plugin: subscribe to
 * \`content.entry.updated\`, skip own writes via the \`actor\` field, then
 * read / patch the entry through \`api.cms.content.*\`.
 */
const mod: ServerPluginModule = {
  activate(api) {
    api.cms.hooks.on('content.entry.updated', async ({ tableSlug, entryId, actor }) => {
      if (tableSlug !== 'pages') return
      if (actor.kind === 'plugin' && actor.pluginId === api.plugin.id) return

      const entry = await api.cms.content.table('pages').get(entryId)
      if (!entry) return

      // …react to the user's change here. Example: auto-fill a meta
      // description from the page body if the user hasn't set one.
      if (!entry.cells.metaDescription && typeof entry.cells.body === 'string') {
        await api.cms.content.table('pages').update(entryId, {
          cells: { metaDescription: entry.cells.body.slice(0, 160) },
        })
      }
    })
  },
}

export default mod
`
}

function helloModuleTemplate({ pluginId }: InitTemplate): string {
  return `import { control, defineModule, html } from '@instatic/plugin-sdk'

export default defineModule({
  id: '${pluginId}.hello',
  name: 'Hello',
  description: 'Sample canvas module emitted by the scaffolded plugin.',
  category: '${capitaliseWordsFromId(pluginId)}',
  htmlTag: 'div',
  defaults: {
    message: 'Hello from your new plugin.',
  },
  schema: {
    message: control.text('Message'),
  },
  render: ({ props }) => ({
    html: html\`<div class="hello">\${props.message}</div>\`,
    css: \`.hello { padding: 12px; border: 1px dashed currentColor; border-radius: 6px; }\`,
  }),
})
`
}

function capitaliseWordsFromId(pluginId: string): string {
  const tail = pluginId.split('.').slice(1).join(' ')
  return capitaliseWords(tail)
}

function readmeTemplate({ pluginId, pluginName }: InitTemplate): string {
  // Packaged, the CLI is a dependency of the plugin project; from source it
  // is the checkout's own `instatic-plugin` script.
  const packaged = SDK_PACKAGE_VERSION !== null
  const cli = packaged ? 'bunx instatic-plugin' : 'bun run instatic-plugin'
  const installStep = packaged ? 'bun install\n' : ''
  const tarballNote = SDK_PACKAGE_VERSION === null
    ? ''
    : `
\`${SDK_PACKAGE_NAME}\` installs from npm. The same package is attached to
every Instatic release; to install it from there instead, set the dependency
in \`package.json\` to
\`${sdkTarballUrl(SDK_PACKAGE_VERSION)}\`.
`
  return `# ${pluginName}

> Plugin id: \`${pluginId}\`

## Develop

\`\`\`bash
${installStep}${cli} dev      # watch + sync into the running CMS
${cli} lint     # validate the manifest and sources
${cli} build    # produce a .plugin.zip
\`\`\`

The dev command writes built files directly into the host CMS's
\`uploads/plugins/${pluginId}/<version>/\` directory. Tell it where that is
with \`--uploads <path>\` or \`INSTATIC_UPLOADS_DIR\`; inside an Instatic
checkout it finds the \`uploads/\` folder by walking up from the plugin
directory.

You'll need to install the plugin once via the admin UI (\`/admin/plugins\` →
Upload Plugin) so the host registers it and approves permissions. After
that, every \`${cli} dev\` rebuild flows in without another upload.

${tarballNote}
The full plugin SDK surface is documented in
[plugin-system.md](https://github.com/CoreBunch/Instatic/blob/main/docs/features/plugin-system.md).
`
}

function gitignoreTemplate(): string {
  return `node_modules
dist
*.plugin.zip
.DS_Store
`
}
