import { afterAll, describe, expect, it } from 'bun:test'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { serverArtifactPlugins } from './serverArtifactPlugins'

const ROOT = resolve(import.meta.dir, '../..')
// Under `.tmp/` like the real compile entry, so `@core/*` paths resolve the same way.
const WORK_DIR = join(ROOT, '.tmp', 'server-artifact-plugins-test')
const HOST = `bun-${process.platform}-${process.arch}`
const ESBUILD_PACKAGE = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
const ESBUILD_FILE = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
const ESBUILD_VERSION = (JSON.parse(readFileSync(join(ROOT, 'node_modules', 'esbuild', 'package.json'), 'utf-8')) as { version: string }).version

// Every entry starts like this: reading any `node_modules` path throws. Inside a
// compiled binary such a read can only mean a build-machine path was baked in, and
// on the build machine that read would otherwise succeed and hide the defect, which
// is how v0.0.19 shipped unbootable.
const DENY_NODE_MODULES = `
import fs from 'node:fs'
const readFileSync = fs.readFileSync
fs.readFileSync = ((path, ...rest) => {
  if (String(path).includes('node_modules')) throw new Error('compiled binary read a build-machine path: ' + path)
  return readFileSync(path, ...rest)
}) as typeof fs.readFileSync
`

/**
 * Compile `source` with the artifact plugins, reject any binary that still
 * contains this machine's `node_modules` path, then run it from an unrelated
 * cwd and return its stdout. The structural check comes first because
 * `require.resolve` bake-ins bypass `fs` and would pass the run here, where
 * the path exists.
 */
async function compileAndRun(name: string, source: string): Promise<string> {
  await mkdir(WORK_DIR, { recursive: true })
  const entry = join(WORK_DIR, `${name}.ts`)
  const outfile = join(WORK_DIR, `${name}-binary`)
  await writeFile(entry, source, 'utf-8')

  const build = await Bun.build({
    entrypoints: [entry],
    compile: { outfile, target: HOST },
    plugins: serverArtifactPlugins(ROOT),
  })
  expect(build.logs.map(String)).toEqual([])
  expect(build.success).toBe(true)

  // Bake-ins carry resolved paths, and a worktree's `node_modules` is a symlink.
  const buildNodeModules = Buffer.from(realpathSync(join(ROOT, 'node_modules')) + sep)
  const binary = Buffer.from(await Bun.file(outfile).arrayBuffer())
  const bakedAt = binary.indexOf(buildNodeModules)
  if (bakedAt !== -1) {
    throw new Error(`build-machine path baked into ${name}: ${binary.subarray(Math.max(0, bakedAt - 80), bakedAt + 160).toString()}`)
  }

  const run = Bun.spawnSync({ cmd: [outfile], cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`${name} exited ${run.exitCode}:\n${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

describe('serverArtifactPlugins', () => {
  afterAll(() => rm(WORK_DIR, { recursive: true, force: true }))

  it("compiles a server binary that boots the jsdom sanitizer without the build machine's files", async () => {
    const stdout = await compileAndRun('sanitizer', `${DENY_NODE_MODULES}
await import('../../server/richtextSanitizer')
const { sanitizeRichtext } = await import('../../src/core/sanitize')
console.log(JSON.stringify(sanitizeRichtext('<p>kept</p><img src=x onerror=alert(1)><script>alert(1)</script>')))
`)
    const sanitized = JSON.parse(stdout) as string
    expect(sanitized).toContain('<p>kept</p>')
    expect(sanitized).not.toContain('<script')
    expect(sanitized).not.toContain('onerror')
  }, 60_000)

  it("compiles a server binary that bundles site runtime scripts without the build machine's files", async () => {
    // The same preamble the artifact entry generates: embed esbuild's binary
    // and extract it before anything imports esbuild. A module script drives
    // esbuild.build, a classic script drives the esbuild.transform syntax check.
    const stdout = await compileAndRun('runtime-scripts', `// @ts-expect-error file embed
import esbuildBinaryPath from '../../node_modules/@esbuild/${ESBUILD_PACKAGE}/${ESBUILD_FILE}' with { type: 'file' }
import { installEsbuildBinary } from '../../scripts/lib/serverArtifactRuntime'
${DENY_NODE_MODULES}
await installEsbuildBinary(esbuildBinaryPath, '${ESBUILD_VERSION}', '${ESBUILD_FILE.split('/').pop()}')
const { DEFAULT_SCRIPT_RUNTIME_CONFIG } = await import('../../src/core/site-runtime')
const { createDefaultSiteExplorerOrganization, DEFAULT_SITE_SETTINGS } = await import('../../src/core/page-tree')
const { buildSiteRuntimeScripts } = await import('../../server/publish/runtime/bundleScripts')
const page = { id: 'page-1', slug: 'index', title: 'Index', rootNodeId: 'root', nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, children: [], breakpointOverrides: {}, classIds: [], locked: false, hidden: false } } }
const file = (id, path, content) => ({ id, path, type: 'script', content, createdAt: 1, updatedAt: 1 })
const site = {
  id: 'site-1', name: 'Artifact Test Site', pages: [page], visualComponents: [], layouts: [],
  breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
  settings: structuredClone(DEFAULT_SITE_SETTINGS), styleRules: {},
  files: [file('app', 'assets/js/app.js', 'export const answer = 6 * 7; console.log(answer)'), file('legacy', 'assets/js/legacy.js', 'window.legacy = 1')],
  explorer: createDefaultSiteExplorerOrganization(), packageJson: { dependencies: {}, devDependencies: {} },
  runtime: { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, styles: {}, scripts: { app: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG }, legacy: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, format: 'classic' } } },
  createdAt: 1, updatedAt: 1,
}
const result = await buildSiteRuntimeScripts({ site, page, target: 'publish', assetBasePath: '/_instatic/assets/version-1/' })
console.log(JSON.stringify({ errors: result.diagnostics.filter((d) => d.severity === 'error'), formats: result.runtimeAssets.scripts.map((s) => s.format).sort(), files: result.files.map((f) => f.path) }))
`)
    const built = JSON.parse(stdout) as { errors: unknown[]; formats: string[]; files: string[] }
    expect(built.errors).toEqual([])
    expect(built.formats).toEqual(['classic', 'module'])
    expect(built.files.some((path) => path.includes('entries/'))).toBe(true)
  }, 120_000)
})
