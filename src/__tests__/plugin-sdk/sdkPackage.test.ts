/**
 * Gate: `@instatic/plugin-sdk` works from a project that is NOT inside the
 * Instatic checkout.
 *
 * The suite builds the package the way a release does, unpacks the tarball
 * into a project under the OS temp directory, and drives the packaged CLI
 * there: `init` for both kinds, `tsc`, `lint`, `build`. The built plugin is
 * then compared with what the in-repo CLI builds from the same source.
 *
 * No network: the package's declared dependencies are symlinked from this
 * checkout's `node_modules` instead of installed. What that cannot prove, the
 * package build asserts itself (`assertDependenciesAreDeclared` fails when
 * the built files import a package the manifest does not declare).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { parsePluginManifest } from '@core/plugins/manifest'
import { PLUGIN_API_VERSION } from '@core/plugin-sdk'
import { safeParseJson } from '@core/utils/jsonValidate'
import { buildPlugin } from '../../core/plugin-sdk/cli/build'
import { runPluginInit } from '../../core/plugin-sdk/cli/init'
import { sdkTarballName, sdkTarballUrl } from '../../core/plugin-sdk/cli/sdkPackage'
import {
  buildPluginSdkPackage,
  collectDeclarationImports,
  collectJavaScriptImports,
  type BuiltSdkPackage,
} from '../../../scripts/lib/pluginSdkPackage'

const PROJECT_ROOT = join(import.meta.dir, '../../..')
const REPO_ALIAS_PREFIXES = ['@core/', '@site/', '@ui/', '@admin/', '@modules/', '@content/', '@plugins/', '@users/']
const SLOW = 120_000

const PackageManifestSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  bin: Type.Record(Type.String(), Type.String()),
  engines: Type.Object({ bun: Type.String() }),
  dependencies: Type.Record(Type.String(), Type.String()),
  instatic: Type.Object({ pluginApiVersion: Type.Number() }),
})

const ScaffoldManifestSchema = Type.Object({
  devDependencies: Type.Record(Type.String(), Type.String()),
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

/** A config or build tool file in an ancestor would make the project not really out of tree. */
function ancestorsWithProjectFiles(dir: string): string[] {
  const found: string[] = []
  let current = dirname(dir)
  for (;;) {
    for (const name of ['tsconfig.json', 'package.json', 'node_modules']) {
      if (existsSync(join(current, name))) found.push(join(current, name))
    }
    const parent = dirname(current)
    if (parent === current) return found
    current = parent
  }
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

/** Each line is wrong only if the SDK's types are real: an \`any\` would accept all three. */
const TYPE_ERROR_SOURCE = `import { definePlugin } from '@instatic/plugin-sdk'
import { Button } from '@instatic/host-ui'
import { useEditorStore } from '@instatic/host-hooks'

export const a: number = definePlugin
export const b: number = Button
export const c: number = useEditorStore
`

describe('@instatic/plugin-sdk package, used outside the checkout', () => {
  let built: BuiltSdkPackage
  let outRoot: string
  let projectDir: string
  let installedDir: string
  let cli: string[]
  let tsc: string[]
  let inRepoDir: string

  beforeAll(async () => {
    outRoot = await realpath(await mkdtemp(join(tmpdir(), 'instatic-sdk-pack-')))
    projectDir = await realpath(await mkdtemp(join(tmpdir(), 'instatic-sdk-project-')))
    built = await buildPluginSdkPackage({ outRoot })

    const nodeModules = join(projectDir, 'node_modules')
    installedDir = join(nodeModules, '@instatic', 'plugin-sdk')
    await mkdir(dirname(installedDir), { recursive: true })
    const unpack = await run(['tar', '-xzf', built.tarballPath, '-C', dirname(installedDir)], projectDir)
    expect(unpack.exitCode).toBe(0)
    await cp(join(dirname(installedDir), 'package'), installedDir, { recursive: true })
    await rm(join(dirname(installedDir), 'package'), { recursive: true, force: true })

    const manifest = await readJsonFile(join(installedDir, 'package.json'), PackageManifestSchema)
    // What `bun install` would fetch, linked from this checkout instead; plus
    // the two packages a plugin author adds to typecheck editor code.
    for (const name of [...Object.keys(manifest.dependencies), 'typescript', '@types/react']) {
      const target = join(PROJECT_ROOT, 'node_modules', name)
      expect(existsSync(target)).toBe(true)
      await mkdir(dirname(join(nodeModules, name)), { recursive: true })
      await symlink(target, join(nodeModules, name), 'dir')
    }

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

  it('runs in a project with no Instatic file above it', () => {
    expect(projectDir.startsWith(PROJECT_ROOT)).toBe(false)
    expect(ancestorsWithProjectFiles(projectDir)).toEqual([])
  })

  it('packs a manifest that names the CLI, the Bun requirement and the plugin apiVersion', async () => {
    const manifest = await readJsonFile(join(installedDir, 'package.json'), PackageManifestSchema)
    expect(manifest.name).toBe('@instatic/plugin-sdk')
    expect(manifest.version).toBe(built.version)
    expect(built.tarballPath.endsWith(sdkTarballName(built.version))).toBe(true)
    expect(manifest.engines.bun.startsWith('>=')).toBe(true)
    expect(manifest.instatic.pluginApiVersion).toBe(PLUGIN_API_VERSION)

    const cliPath = join(installedDir, manifest.bin['instatic-plugin'])
    expect((await readFile(cliPath, 'utf-8')).startsWith('#!/usr/bin/env bun\n')).toBe(true)
    expect((await stat(cliPath)).mode & 0o111).not.toBe(0)
  })

  it('leaves no repo-only specifier in the packed JavaScript or declarations', async () => {
    const javascript = await collectJavaScriptImports(join(installedDir, 'dist'))
    const declarations = await collectDeclarationImports(join(installedDir, 'types'))
    const specifiers = [...javascript.keys(), ...declarations.keys()]
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((s) => REPO_ALIAS_PREFIXES.some((prefix) => s.startsWith(prefix)))).toEqual([])
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

  it('scaffolds, typechecks, lints and builds a content-editor plugin', async () => {
    const init = await run([...cli, 'init', 'acme.seo', '--kind', 'content-editor'], projectDir)
    expect(init.output).toContain('Created plugin')
    expect(init.exitCode).toBe(0)
    const pluginDir = join(projectDir, 'seo')

    const scaffold = await readJsonFile(join(pluginDir, 'package.json'), ScaffoldManifestSchema)
    expect(scaffold.devDependencies['@instatic/plugin-sdk']).toBe(built.version)
    expect(await readFile(join(pluginDir, 'README.md'), 'utf-8')).toContain(sdkTarballUrl(built.version))
    expect(await readFile(join(pluginDir, 'instatic-plugin.config.ts'), 'utf-8')).toContain("from '@instatic/plugin-sdk'")

    const typecheck = await run([...tsc, pluginDir], pluginDir)
    expect(typecheck.output).toBe('')
    expect(typecheck.exitCode).toBe(0)

    const lint = await run([...cli, 'lint', pluginDir], projectDir)
    expect(lint.output).toContain('no issues found')
    expect(lint.exitCode).toBe(0)

    const build = await run([...cli, 'build', pluginDir], projectDir)
    expect(build.output).toContain('Built acme.seo')
    expect(build.exitCode).toBe(0)
    expect(existsSync(join(projectDir, 'seo.plugin.zip'))).toBe(true)

    const manifest = parsePluginManifest(JSON.parse(await readFile(join(pluginDir, 'dist', 'plugin.json'), 'utf-8')))
    expect(manifest.id).toBe('acme.seo')
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION)
    expect(manifest.entrypoints?.server).toBe('server/index.js')
  }, SLOW)

  it('typechecks editor code against the host modules and builds the same plugin as the in-repo CLI', async () => {
    const init = await run([...cli, 'init', 'acme.hero'], projectDir)
    expect(init.exitCode).toBe(0)
    const pluginDir = join(projectDir, 'hero')

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

    const lint = await run([...cli, 'lint', pluginDir], projectDir)
    expect(lint.output).toContain('no issues found')
    expect(lint.exitCode).toBe(0)

    const build = await run([...cli, 'build', pluginDir], projectDir)
    expect(build.output).toContain('Built acme.hero')
    expect(build.exitCode).toBe(0)

    const editorBundle = await readFile(join(pluginDir, 'dist', 'editor', 'index.js'), 'utf-8')
    for (const hostModule of ['react', '@instatic/host-ui', '@instatic/host-hooks', '@instatic/plugin-sdk']) {
      expect(editorBundle).toContain(`from "${hostModule}"`)
    }

    // Same source through the in-repo CLI. The project files stay behind: a
    // tsconfig.json of its own would hide the checkout's SDK path mapping.
    const inRepoPlugin = join(inRepoDir, 'hero')
    await mkdir(inRepoPlugin, { recursive: true })
    for (const name of ['instatic-plugin.config.ts', 'modules', 'editor']) {
      await cp(join(pluginDir, name), join(inRepoPlugin, name), { recursive: true })
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
    // bundler's source-path comments the two builds are the same text.
    const inRepoEditorBundle = await readFile(join(inRepo.outputDir, 'editor', 'index.js'), 'utf-8')
    expect(withoutSourcePathComments(inRepoEditorBundle)).toBe(withoutSourcePathComments(editorBundle))
  }, SLOW)

  it('fails the typecheck where plugin code misuses an SDK or host type', async () => {
    const pluginDir = join(projectDir, 'hero')
    const probe = join(pluginDir, 'type-errors.ts')
    await writeFile(probe, TYPE_ERROR_SOURCE, 'utf-8')
    try {
      const typecheck = await run([...tsc, pluginDir], pluginDir)
      expect(typecheck.exitCode).not.toBe(0)
      for (const line of [5, 6, 7]) {
        expect(typecheck.output).toContain(`type-errors.ts(${line},14): error TS2322`)
      }
    } finally {
      await rm(probe, { force: true })
    }
  }, SLOW)
})

describe('instatic-plugin init from source, inside the checkout', () => {
  it('writes no package.json or tsconfig.json, and imports the SDK by its package name', async () => {
    const parentDir = join(PROJECT_ROOT, '.tmp-lint')
    await mkdir(parentDir, { recursive: true })
    const dir = await mkdtemp(join(parentDir, 'sdk-init-'))
    try {
      const pluginDir = await runPluginInit('acme.inrepo', { parentDir: dir })
      expect(existsSync(join(pluginDir, 'package.json'))).toBe(false)
      expect(existsSync(join(pluginDir, 'tsconfig.json'))).toBe(false)
      expect(await readFile(join(pluginDir, 'instatic-plugin.config.ts'), 'utf-8')).toContain(
        "from '@instatic/plugin-sdk'",
      )
      const result = await buildPlugin(pluginDir, { zip: false })
      expect(result.pluginId).toBe('acme.inrepo')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
