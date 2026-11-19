/**
 * Gate: `@instatic/plugin-sdk` works from a project that is NOT inside the
 * Instatic checkout.
 *
 * The suite builds the package the way a release does, unpacks the tarball
 * into a project under the OS temp directory, and drives the packaged CLI
 * there: `init` for both kinds, `tsc`, `lint`, `build`, `dev`.
 *
 * No network: instead of running `bun install`, the suite links exactly what
 * the SDK package and the scaffold's own `package.json` declare from this
 * checkout's `node_modules`. A package neither of them declares is not there,
 * so a missing declaration fails the typecheck or the CLI. The package build
 * also asserts it itself (`assertDependenciesAreDeclared`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { parsePluginManifest } from '@core/plugins/manifest'
import { PLUGIN_API_VERSION } from '@core/plugin-sdk'
import { safeParseJson } from '@core/utils/jsonValidate'
import { buildPlugin } from '../../core/plugin-sdk/cli/build'
import { runPluginInit, scaffoldCommands } from '../../core/plugin-sdk/cli/init'
import { sdkTarballName, sdkTarballUrl } from '../../core/plugin-sdk/cli/sdkPackage'
import {
  buildPluginSdkPackage,
  collectDeclarationImports,
  collectJavaScriptImports,
  type BuiltSdkPackage,
} from '../../../scripts/lib/pluginSdkPackage'

const PROJECT_ROOT = join(import.meta.dir, '../../..')
const REPO_ALIAS_PREFIXES = ['@core/', '@site/', '@ui/', '@admin/', '@modules/', '@content/', '@plugins/', '@users/']
const SDK = '@instatic/plugin-sdk'
const SLOW = 120_000

const PackageManifestSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  bin: Type.Record(Type.String(), Type.String()),
  engines: Type.Object({ bun: Type.String() }),
  repository: Type.Object({ url: Type.String() }),
  dependencies: Type.Record(Type.String(), Type.String()),
  instatic: Type.Object({ pluginApiVersion: Type.Number() }),
})

const ScaffoldManifestSchema = Type.Object({
  scripts: Type.Record(Type.String(), Type.String()),
  devDependencies: Type.Record(Type.String(), Type.String()),
})

const ScaffoldTsconfigSchema = Type.Object({
  compilerOptions: Type.Record(Type.String(), Type.Unknown()),
})

interface RunResult {
  exitCode: number
  output: string
}

async function run(command: string[], cwd: string): Promise<RunResult> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, output: `${stdout}${stderr}` }
}

async function readJsonFile<T extends TSchema>(path: string, schema: T): Promise<Static<T>> {
  const result = safeParseJson(await readFile(path, 'utf-8'), schema)
  if (!result.ok) throw new Error(`${path}: ${result.error.message}`)
  return result.value
}

async function listRelativeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort()
}

function withoutSourcePathComments(bundle: string): string {
  return bundle.replace(/^\/\/ .*\.(?:tsx?|m?js)$/gm, '')
}

/** Directories above `dir` that would hand the SDK to a project that did not install it. */
function ancestorsProvidingSdk(dir: string): string[] {
  const found: string[] = []
  let current = dirname(dir)
  for (;;) {
    if (existsSync(join(current, 'node_modules', SDK))) found.push(current)
    const parent = dirname(current)
    if (parent === current) return found
    current = parent
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await Bun.sleep(100)
  }
  return existsSync(path)
}

const EDITOR_PANEL_SOURCE = `import { useState } from 'react'
import { Button, Stack, Text } from '@instatic/host-ui'
import { useEditorStore } from '@instatic/host-hooks'
import { definePluginPanel } from '@instatic/plugin-sdk'

function Panel() {
  const [count, setCount] = useState(0)
  const selected = useEditorStore((state) => state.selectedNodeIds.length)
  return (
    <Stack gap={8}>
      <Text>{selected + count}</Text>
      <Button variant="primary" onClick={() => setCount(count + 1)}>Add</Button>
    </Stack>
  )
}

export default definePluginPanel({
  id: 'acme.hero.panel',
  label: 'Hero',
  iconName: 'star',
  component: Panel,
})
`

/**
 * Each line is wrong only if the type it names is real: an \`any\` would
 * accept all of them. The last is the widget icon, whose type comes from the
 * icon declarations shipped inside the package.
 */
const TYPE_ERROR_SOURCE = `import { definePlugin } from '@instatic/plugin-sdk'
import { Button, type WidgetIcon } from '@instatic/host-ui'
import { useEditorStore } from '@instatic/host-hooks'

export const a: number = definePlugin
export const b: number = Button
export const c: number = useEditorStore
export const d: WidgetIcon = 5
`

describe('@instatic/plugin-sdk package, used outside the checkout', () => {
  let built: BuiltSdkPackage
  let outRoot: string
  let projectDir: string
  let nodeModules: string
  let installedDir: string
  let cli: string[]
  let tsc: string[]
  let inRepoDir: string

  /** Link `names` from this checkout, as `bun install` would have installed them. */
  async function link(names: string[]): Promise<void> {
    for (const name of names) {
      const destination = join(nodeModules, name)
      if (existsSync(destination)) continue
      const target = join(PROJECT_ROOT, 'node_modules', name)
      expect(existsSync(target)).toBe(true)
      await mkdir(dirname(destination), { recursive: true })
      await symlink(target, destination, 'dir')
    }
  }

  beforeAll(async () => {
    outRoot = await realpath(await mkdtemp(join(tmpdir(), 'instatic-sdk-pack-')))
    projectDir = await realpath(await mkdtemp(join(tmpdir(), 'instatic-sdk-project-')))
    built = await buildPluginSdkPackage({ outRoot })

    nodeModules = join(projectDir, 'node_modules')
    installedDir = join(nodeModules, SDK)
    await mkdir(dirname(installedDir), { recursive: true })
    const unpack = await run(['tar', '-xzf', built.tarballPath, '-C', dirname(installedDir)], projectDir)
    expect(unpack.exitCode).toBe(0)
    await rename(join(dirname(installedDir), 'package'), installedDir)

    const manifest = await readJsonFile(join(installedDir, 'package.json'), PackageManifestSchema)
    await link(Object.keys(manifest.dependencies))

    cli = [process.execPath, join(installedDir, manifest.bin['instatic-plugin'])]
    tsc = [process.execPath, join(nodeModules, 'typescript', 'bin', 'tsc'), '--noEmit', '-p']

    await mkdir(join(PROJECT_ROOT, '.tmp-lint'), { recursive: true })
    inRepoDir = await mkdtemp(join(PROJECT_ROOT, '.tmp-lint', 'sdk-package-'))
  }, SLOW)

  afterAll(async () => {
    for (const dir of [outRoot, projectDir, inRepoDir]) {
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  })

  /** Scaffold a plugin and link what its own package.json declares. */
  async function scaffold(args: string[], dirName: string): Promise<string> {
    const init = await run([...cli, 'init', ...args], projectDir)
    expect(init.output).toContain('Created plugin')
    expect(init.output).toContain(`cd ${dirName} && bun install && bun run dev`)
    expect(init.exitCode).toBe(0)
    const pluginDir = join(projectDir, dirName)
    const manifest = await readJsonFile(join(pluginDir, 'package.json'), ScaffoldManifestSchema)
    await link(Object.keys(manifest.devDependencies).filter((name) => name !== SDK))
    return pluginDir
  }

  it('is a project the SDK cannot leak into from outside', () => {
    expect(projectDir.startsWith(PROJECT_ROOT)).toBe(false)
    expect(ancestorsProvidingSdk(projectDir)).toEqual([])
    expect(Bun.resolveSync(SDK, projectDir).startsWith(installedDir)).toBe(true)
  })

  it('packs a manifest that names the CLI, the Bun requirement, the repository and the plugin apiVersion', async () => {
    const manifest = await readJsonFile(join(installedDir, 'package.json'), PackageManifestSchema)
    expect(manifest.name).toBe(SDK)
    expect(manifest.version).toBe(built.version)
    expect(built.tarballPath.endsWith(sdkTarballName(built.version))).toBe(true)
    expect(manifest.engines.bun.startsWith('>=')).toBe(true)
    expect(manifest.repository.url).toBe('git+https://github.com/CoreBunch/Instatic.git')
    expect(manifest.instatic.pluginApiVersion).toBe(PLUGIN_API_VERSION)

    const cliPath = join(installedDir, manifest.bin['instatic-plugin'])
    expect((await readFile(cliPath, 'utf-8')).startsWith('#!/usr/bin/env bun\n')).toBe(true)
    expect((await stat(cliPath)).mode & 0o111).not.toBe(0)
  })

  it('rejects a version that is not semver', async () => {
    const attempt = buildPluginSdkPackage({ outRoot: join(outRoot, 'rejected'), version: '1.2.3; rm -rf x' })
    await expect(attempt).rejects.toThrow('is not a semver version')
    expect(existsSync(join(outRoot, 'rejected'))).toBe(false)
  })

  it('leaves no repo-only specifier in the packed JavaScript or declarations', async () => {
    const javascript = await collectJavaScriptImports(join(installedDir, 'dist'))
    const declarations = await collectDeclarationImports(join(installedDir, 'types'))
    const specifiers = [...javascript.keys(), ...declarations.keys()]
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((s) => REPO_ALIAS_PREFIXES.some((prefix) => s.startsWith(prefix)))).toEqual([])
  })

  it('ships only declarations a type entry reaches, and none for the CLI', async () => {
    const files = await listRelativeFiles(join(installedDir, 'types'))
    expect(files).toContain(join('core', 'plugin-sdk', 'index.d.ts'))
    expect(files).toContain(join('vendor', 'pixel-art-icons', 'types.d.ts'))
    expect(files.filter((file) => file.startsWith(join('core', 'plugin-sdk', 'cli')))).toEqual([])
    expect(files.filter((file) => file.startsWith(join('core', 'collab')))).toEqual([])
  })

  it('keeps Node imports out of everything a plugin bundle inlines', async () => {
    // dist/index.js and the shared chunks end up inside sandboxed server and
    // module bundles; only the CLI entry may reach for Node.
    const javascript = await collectJavaScriptImports(join(installedDir, 'dist'))
    const outsideCli = [...javascript]
      .filter(([, files]) => files.some((file) => file !== join('cli', 'index.js')))
      .map(([specifier]) => specifier)
    expect(outsideCli).toEqual([])
  })

  it('scaffolds, typechecks, lints, builds and dev-syncs a content-editor plugin', async () => {
    const pluginDir = await scaffold(['acme.seo', '--kind', 'content-editor'], 'seo')

    const manifestFile = await readJsonFile(join(pluginDir, 'package.json'), ScaffoldManifestSchema)
    // The release asset, not a registry name anyone could claim.
    expect(manifestFile.devDependencies[SDK]).toBe(sdkTarballUrl(built.version))
    expect(Object.keys(manifestFile.devDependencies).sort()).toEqual([SDK, '@types/react', 'typescript'])
    expect(manifestFile.scripts.dev).toBe('instatic-plugin dev')
    const tsconfig = await readJsonFile(join(pluginDir, 'tsconfig.json'), ScaffoldTsconfigSchema)
    expect(tsconfig.compilerOptions.skipLibCheck).toBeUndefined()
    expect(await readFile(join(pluginDir, 'instatic-plugin.config.ts'), 'utf-8')).toContain(`from '${SDK}'`)
    const readme = await readFile(join(pluginDir, 'README.md'), 'utf-8')
    expect(readme).toContain('bun run sdk:pack')
    expect(readme).toContain('bun run dev')

    // No skipLibCheck: the SDK's own declarations are checked too.
    const typecheck = await run([...tsc, pluginDir], pluginDir)
    expect(typecheck.output).toBe('')
    expect(typecheck.exitCode).toBe(0)

    const lint = await run([...cli, 'lint'], pluginDir)
    expect(lint.output).toContain('no issues found')
    expect(lint.exitCode).toBe(0)

    const build = await run([...cli, 'build'], pluginDir)
    expect(build.output).toContain('Built acme.seo')
    expect(build.exitCode).toBe(0)
    // The zip stays inside the plugin project, where its .gitignore covers it.
    expect(existsSync(join(pluginDir, 'seo.plugin.zip'))).toBe(true)
    expect(existsSync(join(projectDir, 'seo.plugin.zip'))).toBe(false)
    expect(await readFile(join(pluginDir, '.gitignore'), 'utf-8')).toContain('*.plugin.zip')

    const manifest = parsePluginManifest(JSON.parse(await readFile(join(pluginDir, 'dist', 'plugin.json'), 'utf-8')))
    expect(manifest.id).toBe('acme.seo')
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION)
    expect(manifest.entrypoints?.server).toBe('server/index.js')

    // `dev`: one build synced into a host uploads folder, then stopped.
    const uploads = join(projectDir, 'uploads')
    const dev = Bun.spawn([...cli, 'dev', '--uploads', uploads], { cwd: pluginDir, stdout: 'ignore', stderr: 'ignore' })
    try {
      const synced = join(uploads, 'plugins', 'acme.seo', manifest.version)
      expect(await waitForFile(join(synced, 'server', 'index.js'), 30_000)).toBe(true)
      expect(existsSync(join(synced, 'plugin.json'))).toBe(true)
    } finally {
      dev.kill('SIGINT')
      await dev.exited
    }
  }, SLOW)

  it('typechecks editor code against the host modules, and builds the manifest, file set and editor bundle the in-repo CLI builds', async () => {
    const pluginDir = await scaffold(['acme.hero'], 'hero')

    await mkdir(join(pluginDir, 'editor'), { recursive: true })
    await writeFile(join(pluginDir, 'editor', 'index.tsx'), EDITOR_PANEL_SOURCE, 'utf-8')
    const configPath = join(pluginDir, 'instatic-plugin.config.ts')
    const config = await readFile(configPath, 'utf-8')
    expect(config).toContain('permissions: [permissions.modulesRegister]')
    await writeFile(
      configPath,
      config.replace(
        'permissions: [permissions.modulesRegister]',
        'permissions: [permissions.modulesRegister, permissions.editorCode]',
      ),
      'utf-8',
    )

    const typecheck = await run([...tsc, pluginDir], pluginDir)
    expect(typecheck.output).toBe('')
    expect(typecheck.exitCode).toBe(0)

    const lint = await run([...cli, 'lint'], pluginDir)
    expect(lint.output).toContain('no issues found')
    expect(lint.exitCode).toBe(0)

    const build = await run([...cli, 'build'], pluginDir)
    expect(build.output).toContain('Built acme.hero')
    expect(build.exitCode).toBe(0)

    const editorBundle = await readFile(join(pluginDir, 'dist', 'editor', 'index.js'), 'utf-8')
    for (const hostModule of ['react', '@instatic/host-ui', '@instatic/host-hooks', SDK]) {
      expect(editorBundle).toContain(`from "${hostModule}"`)
    }

    // Same source through the in-repo CLI. The project files stay behind: a
    // tsconfig.json of its own would hide the checkout's SDK path mapping.
    const inRepoPlugin = join(inRepoDir, 'hero')
    await mkdir(join(inRepoPlugin, 'modules'), { recursive: true })
    await mkdir(join(inRepoPlugin, 'editor'), { recursive: true })
    for (const file of ['instatic-plugin.config.ts', join('modules', 'hello.ts'), join('editor', 'index.tsx')]) {
      await writeFile(join(inRepoPlugin, file), await readFile(join(pluginDir, file), 'utf-8'), 'utf-8')
    }
    const inRepo = await buildPlugin(inRepoPlugin)

    expect(await listRelativeFiles(inRepo.outputDir)).toEqual(await listRelativeFiles(join(pluginDir, 'dist')))
    const packagedManifest = parsePluginManifest(
      JSON.parse(await readFile(join(pluginDir, 'dist', 'plugin.json'), 'utf-8')),
    )
    const inRepoManifest = parsePluginManifest(
      JSON.parse(await readFile(join(inRepo.outputDir, 'plugin.json'), 'utf-8')),
    )
    expect(packagedManifest).toEqual(inRepoManifest)
    // The editor bundle externalizes every host module, so apart from the
    // bundler's source-path comments the two builds are the same text. The
    // module pack is NOT compared: it inlines the SDK, which the package
    // ships prebuilt, so the two tree-shake differently.
    const inRepoEditorBundle = await readFile(join(inRepo.outputDir, 'editor', 'index.js'), 'utf-8')
    expect(withoutSourcePathComments(inRepoEditorBundle)).toBe(withoutSourcePathComments(editorBundle))
  }, SLOW)

  it('fails the typecheck where plugin code misuses an SDK, host or icon type', async () => {
    const pluginDir = join(projectDir, 'hero')
    const probe = join(pluginDir, 'type-errors.ts')
    await writeFile(probe, TYPE_ERROR_SOURCE, 'utf-8')
    try {
      const typecheck = await run([...tsc, pluginDir], pluginDir)
      expect(typecheck.exitCode).not.toBe(0)
      for (const line of [5, 6, 7, 8]) {
        expect(typecheck.output).toContain(`type-errors.ts(${line},14): error TS2322`)
      }
    } finally {
      await rm(probe, { force: true })
    }
  }, SLOW)
})

describe('instatic-plugin init from source, inside the checkout', () => {
  it('writes no package.json or tsconfig.json, prints commands that take the plugin path, and builds', async () => {
    const parentDir = join(PROJECT_ROOT, '.tmp-lint')
    await mkdir(parentDir, { recursive: true })
    const dir = await mkdtemp(join(parentDir, 'sdk-init-'))
    try {
      const pluginDir = await runPluginInit('acme.inrepo', { parentDir: dir })
      expect((await readdir(pluginDir)).sort()).toEqual(['.gitignore', 'README.md', 'instatic-plugin.config.ts', 'modules'])
      expect(await readFile(join(pluginDir, 'instatic-plugin.config.ts'), 'utf-8')).toContain(`from '${SDK}'`)

      // `bun run instatic-plugin` always runs from the checkout root, so the
      // documented commands name the plugin folder.
      const commands = scaffoldCommands(pluginDir)
      expect(commands.setup).toBeNull()
      expect(commands.build.startsWith('bun run instatic-plugin build ')).toBe(true)
      const readme = await readFile(join(pluginDir, 'README.md'), 'utf-8')
      expect(readme).toContain(commands.dev)
      expect(readme).not.toContain('bunx')

      const [, , ...args] = commands.build.split(' ')
      const build = await run([process.execPath, 'run', ...args], process.cwd())
      expect(build.output).toContain('Built acme.inrepo')
      expect(build.exitCode).toBe(0)
      expect(existsSync(join(pluginDir, 'inrepo.plugin.zip'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, SLOW)
})
