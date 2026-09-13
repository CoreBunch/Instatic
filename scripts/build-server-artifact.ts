/**
 * Build per-platform runnable server artifacts: a `bun build --compile`
 * single-file server binary plus the admin `dist/`, packed as
 * `instatic-server-<version>-<platform>.tar.gz` with a sha256 checksums file.
 *
 * These assets let a release run anywhere Bun does, no container needed (a
 * release is "artifact-enabled" when they are present). The compile has four
 * requirements the CLI can't express, so the build goes through `Bun.build`
 * (plugins in `scripts/lib/serverArtifactPlugins.ts`):
 *
 *  1. `sharp` must resolve to its CJS entry — the ESM entry loads the native
 *     binding via `createRequire(import.meta.url)`, which cannot resolve bare
 *     specifiers inside a compiled binary. The CJS entry uses literal
 *     `require()` calls the bundler embeds.
 *  2. Every non-target `@img/*` package must be externalized — with all
 *     platforms installed (`bun install --os='*' --cpu='*'`), every
 *     platform's native blobs would otherwise embed into every binary.
 *  3. jsdom's default stylesheet must be inlined, its sync-XHR worker dropped,
 *     and css-tree routed to its CJS build — the originals resolve files
 *     at runtime relative to `__dirname` / `import.meta.url`, which inside a
 *     compiled binary name the build machine, not `/$bunfs`.
 *  4. esbuild's Go binary must be embedded and extracted at boot, with
 *     `ESBUILD_BINARY_PATH` pointing at it: esbuild otherwise locates the
 *     binary relative to `__dirname`. After compiling, the binary is scanned
 *     for this machine's `node_modules` path and the build fails if any
 *     survived.
 *
 * Usage:
 *   bun scripts/build-server-artifact.ts [targets...] [--all] [--version <v>]
 *
 * Targets: darwin-arm64 | darwin-x64 | linux-x64 (default: host platform).
 * Cross-target builds need `bun install --os='*' --cpu='*'` first.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { serverArtifactPlugins } from './lib/serverArtifactPlugins'

const ROOT = resolve(import.meta.dir, '..')
const OUT_DIR = join(ROOT, '.tmp', 'server-artifacts')
const ENTRY_DIR = join(ROOT, '.tmp')

const SUPPORTED_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'windows-x64'] as const
type ArtifactTarget = (typeof SUPPORTED_TARGETS)[number]

/** npm platform suffix for `@img/sharp-*` and `@esbuild/*` packages (windows is `win32` there). */
function npmPlatform(target: ArtifactTarget): string {
  return target === 'windows-x64' ? 'win32-x64' : target
}

function isSupportedTarget(value: string): value is ArtifactTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(value)
}

function hostTarget(): ArtifactTarget {
  const host = `${process.platform}-${process.arch}`
  if (!isSupportedTarget(host)) {
    throw new Error(`Host platform ${host} is not a supported artifact target (${SUPPORTED_TARGETS.join(', ')})`)
  }
  return host
}

function parseArgs(): { targets: ArtifactTarget[]; version: string | null } {
  const args = Bun.argv.slice(2)
  const targets: ArtifactTarget[] = []
  let version: string | null = null
  let all = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--all') all = true
    else if (arg === '--version') {
      version = args[++i] ?? null
      if (!version) throw new Error('--version requires a value')
    } else if (isSupportedTarget(arg)) targets.push(arg)
    else throw new Error(`Unknown argument: ${arg}. Targets: ${SUPPORTED_TARGETS.join(', ')}`)
  }
  if (all) return { targets: [...SUPPORTED_TARGETS], version }
  return { targets: targets.length > 0 ? targets : [hostTarget()], version }
}

async function resolveVersion(explicit: string | null): Promise<string> {
  if (explicit) return explicit.replace(/^v/, '')
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8')) as { version?: string }
  if (!pkg.version) throw new Error('package.json has no version')
  return pkg.version
}

/** libvips binary filename inside the sharp platform package is versioned — discover it. */
function findLibvips(target: ArtifactTarget): { pkgDir: string; file: string } {
  const pkgDir = join(ROOT, 'node_modules', '@img', `sharp-libvips-${npmPlatform(target)}`, 'lib')
  if (!existsSync(pkgDir)) {
    throw new Error(
      `Missing @img/sharp-libvips-${npmPlatform(target)}. Cross-target builds need: bun install --os='*' --cpu='*'`,
    )
  }
  const file = readdirSync(pkgDir).find((name) => name.startsWith('libvips-cpp.'))
  if (!file) throw new Error(`No libvips-cpp library found in ${pkgDir}`)
  return { pkgDir, file }
}

/** Windows keeps its DLLs inside `@img/sharp-win32-x64/lib` — discover both. */
function findWindowsDlls(): { base: string; cpp: string } {
  const pkgDir = join(ROOT, 'node_modules', '@img', 'sharp-win32-x64', 'lib')
  if (!existsSync(pkgDir)) {
    throw new Error(`Missing @img/sharp-win32-x64. Cross-target builds need: bun install --os='*' --cpu='*'`)
  }
  const names = readdirSync(pkgDir)
  const cpp = names.find((name) => name.startsWith('libvips-cpp'))
  const base = names.find((name) => name.startsWith('libvips-') && !name.startsWith('libvips-cpp'))
  if (!cpp || !base) throw new Error(`libvips DLLs not found in ${pkgDir} (saw: ${names.join(', ')})`)
  return { base, cpp }
}

/** esbuild's Go binary for a target; embedded and extracted at boot (see serverArtifactRuntime.ts). */
function findEsbuildBinary(target: ArtifactTarget): { file: string; version: string } {
  const file = target === 'windows-x64' ? 'esbuild.exe' : 'bin/esbuild'
  if (!existsSync(join(ROOT, 'node_modules', '@esbuild', npmPlatform(target), file))) {
    throw new Error(`Missing @esbuild/${npmPlatform(target)}. Cross-target builds need: bun install --os='*' --cpu='*'`)
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'esbuild', 'package.json'), 'utf-8')) as { version: string }
  return { file, version: pkg.version }
}

function entrySource(target: ArtifactTarget): string {
  const esbuild = findEsbuildBinary(target)
  const esbuildEmbed = `// @ts-expect-error file embed
import esbuildBinaryPath from '../node_modules/@esbuild/${npmPlatform(target)}/${esbuild.file}' with { type: 'file' }`
  const esbuildInstall = `await installEsbuildBinary(esbuildBinaryPath, '${esbuild.version}', '${basename(esbuild.file)}')`
  if (target === 'windows-x64') {
    const { base, cpp } = findWindowsDlls()
    const libvipsVersion = /^libvips-cpp-(.+)\.dll$/.exec(cpp)?.[1] ?? cpp
    return `// GENERATED by scripts/build-server-artifact.ts — compile entry for ${target}.
// Bun extracts embedded files under hashed names, which breaks Windows
// by-name DLL dependency resolution — self-extract both DLLs with their
// real names first. The Windows loader resolves a module's by-name imports
// against the process's already-loaded module list before searching disk
// (and never searches the loaded DLL's own directory), so preload
// bottom-up: ${base} ← ${cpp} ← sharp.node. Extraction is per-libvips
// version and tolerant of a sibling server holding the same DLLs mapped
// (extraction lives in scripts/lib/serverArtifactRuntime.ts).
// @ts-expect-error file embed
import libvipsBasePath from '../node_modules/@img/sharp-win32-x64/lib/${base}' with { type: 'file' }
// @ts-expect-error file embed
import libvipsCppPath from '../node_modules/@img/sharp-win32-x64/lib/${cpp}' with { type: 'file' }
${esbuildEmbed}
import { dlopen, ptr } from 'bun:ffi'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractEmbeddedFile, installEsbuildBinary } from '../scripts/lib/serverArtifactRuntime'

const libDir = join(tmpdir(), 'instatic-native', '${libvipsVersion}')
const baseDll = await extractEmbeddedFile(libDir, '${base}', libvipsBasePath)
const cppDll = await extractEmbeddedFile(libDir, '${cpp}', libvipsCppPath)
// Belt-and-braces: PATH is the loader's fallback should a preload be bypassed.
process.env.PATH = libDir + ';' + (process.env.PATH ?? '')
dlopen(baseDll, { vips_version: { args: ['i32'], returns: 'i32' } })
// ${cpp} exports only C++-mangled names, which bun:ffi cannot request (its
// generated wrapper needs each symbol to be a valid C identifier). Load it
// through the Win32 loader instead: a by-path LoadLibraryW puts the module
// in the process list under its real name, which is exactly what the sharp
// .node's import resolution needs.
const kernel32 = dlopen('kernel32.dll', { LoadLibraryW: { args: ['ptr'], returns: 'ptr' } })
const cppDllWide = new Uint16Array(cppDll.length + 1)
for (let i = 0; i < cppDll.length; i++) cppDllWide[i] = cppDll.charCodeAt(i)
if (!kernel32.symbols.LoadLibraryW(ptr(cppDllWide))) {
  throw new Error('Failed to load ' + cppDll)
}
require('@img/sharp-win32-x64/sharp.node')
${esbuildInstall}
await import('../server/index.ts')
`
  }
  const { file: libvipsFile } = findLibvips(target)
  return `// GENERATED by scripts/build-server-artifact.ts — compile entry for ${target}.
// Embeds libvips, preloads it via dlopen (the .node's loader dependency is
// then satisfied in-process), embeds the sharp native binding, extracts
// esbuild's binary, then boots the server. See the script header for why
// this wrapper exists.
// @ts-expect-error file embed
import libvipsPath from '../node_modules/@img/sharp-libvips-${target}/lib/${libvipsFile}' with { type: 'file' }
${esbuildEmbed}
import { dlopen } from 'bun:ffi'
import { installEsbuildBinary } from '../scripts/lib/serverArtifactRuntime'
dlopen(libvipsPath, { vips_version: { args: ['i32'], returns: 'i32' } })
require('@img/sharp-${target}/sharp.node')
${esbuildInstall}
await import('../server/index.ts')
`
}

async function compileBinary(target: ArtifactTarget, outfile: string): Promise<void> {
  const sharpNative = join(ROOT, 'node_modules', '@img', `sharp-${npmPlatform(target)}`)
  if (!existsSync(sharpNative)) {
    throw new Error(
      `Missing @img/sharp-${npmPlatform(target)}. Cross-target builds need: bun install --os='*' --cpu='*'`,
    )
  }
  const entryPath = join(ENTRY_DIR, `server-artifact-entry-${target}.ts`)
  await mkdir(ENTRY_DIR, { recursive: true })
  await writeFile(entryPath, entrySource(target), 'utf-8')

  const external = [
    ...readdirSync(join(ROOT, 'node_modules', '@img'))
      .filter((name) => name.startsWith('sharp-') && !name.endsWith(`-${npmPlatform(target)}`))
      .flatMap((name) => [`@img/${name}`, `@img/${name}/*`]),
    ...readdirSync(join(ROOT, 'node_modules', '@esbuild'))
      .filter((name) => name !== npmPlatform(target))
      .flatMap((name) => [`@esbuild/${name}`, `@esbuild/${name}/*`]),
  ]

  const result = await Bun.build({
    entrypoints: [entryPath],
    external,
    compile: { outfile, target: `bun-${target}` },
    plugins: serverArtifactPlugins(ROOT),
  })
  if (!result.success) {
    throw new Error(`Compile failed for ${target}:\n${result.logs.join('\n')}`)
  }

  // No absolute path into this machine's node_modules may survive into the
  // binary: it would resolve only here. The same check runs in
  // serverArtifactPlugins.test.ts; this one guards the release build.
  const buildNodeModules = Buffer.from(realpathSync(join(ROOT, 'node_modules')) + sep)
  const binary = Buffer.from(await Bun.file(outfile).arrayBuffer())
  const bakedAt = binary.indexOf(buildNodeModules)
  if (bakedAt !== -1) {
    throw new Error(
      `${target}: build-machine path baked into the binary: ${binary.subarray(Math.max(0, bakedAt - 80), bakedAt + 160).toString()}`,
    )
  }
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest('hex')
}

const { targets, version } = parseArgs()
const resolvedVersion = await resolveVersion(version)

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  throw new Error('dist/ is missing — run `bun run build` before building server artifacts')
}

await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

const checksumLines: string[] = []
for (const target of targets) {
  const artifactName = `instatic-server-${resolvedVersion}-${target}`
  const stageDir = join(OUT_DIR, artifactName)
  await mkdir(stageDir, { recursive: true })

  console.log(`[artifact] compiling ${target}…`)
  const binaryName = target === 'windows-x64' ? 'instatic-server.exe' : 'instatic-server'
  // Bun appends .exe to windows outfiles on its own — hand it the final name.
  await compileBinary(target, join(stageDir, binaryName))
  await cp(join(ROOT, 'dist'), join(stageDir, 'dist'), { recursive: true })
  await cp(join(ROOT, 'LICENSE'), join(stageDir, 'LICENSE'))
  await writeFile(
    join(stageDir, 'manifest.json'),
    `${JSON.stringify({ name: 'instatic-server', version: resolvedVersion, platform: target }, null, 2)}\n`,
    'utf-8',
  )

  const tarballName = `${artifactName}.tar.gz`
  const tar = spawnSync('tar', ['-czf', join(OUT_DIR, tarballName), '-C', OUT_DIR, artifactName], {
    stdio: 'inherit',
  })
  if (tar.status !== 0) throw new Error(`tar failed for ${target} (exit ${tar.status})`)
  await rm(stageDir, { recursive: true, force: true })

  checksumLines.push(`${await sha256(join(OUT_DIR, tarballName))}  ${tarballName}`)
  console.log(`[artifact] ${tarballName} ready`)
}

const checksumsPath = join(OUT_DIR, `instatic-server-${resolvedVersion}-checksums.txt`)
await writeFile(checksumsPath, `${checksumLines.join('\n')}\n`, 'utf-8')
console.log(`[artifact] wrote ${checksumsPath}`)
