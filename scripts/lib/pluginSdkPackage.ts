/**
 * Builds `@instatic/plugin-sdk`, the package a plugin project outside the
 * Instatic checkout installs.
 *
 * The SDK source (`src/core/plugin-sdk/`) imports the page-tree, the
 * publisher's sanitizers, the manifest parser and more through the repo's
 * `@core/*` aliases, so it cannot be published as a copy of its folder. This
 * build turns it into a package with no repo-only specifier left in it:
 *
 *   package/
 *     package.json
 *     README.md, LICENSE
 *     host.d.ts            declares `@instatic/host-ui` + `@instatic/host-hooks`
 *     dist/index.js        runtime builders (definePlugin, defineModule, …)
 *     dist/cli/index.js    the `instatic-plugin` CLI (bin, needs Bun)
 *     dist/chunks/*.js     code the two entries share
 *     types/**             declaration files, alias specifiers made relative
 *
 * Two properties the layout exists for:
 *
 *   • ONE instance. The author's `instatic-plugin.config.ts` imports
 *     `@instatic/plugin-sdk` (dist/index.js) while the CLI evaluates it. Both
 *     entries are built in one pass with code splitting, so they share the
 *     module registry and the sanitizer configuration through `chunks/`
 *     instead of each carrying a private copy.
 *   • Sandbox-safe runtime. `dist/index.js` and the chunks are built for the
 *     browser target: a plugin's server and module bundles inline them, and
 *     those run in QuickJS, where a Node import would fail the sandbox scan.
 *     Only `dist/cli/index.js` imports `node:*`, jsdom and happy-dom.
 *
 * There is no declaration bundler in the repo's dependencies, so types ship
 * as the tree `tsc` emits, with every alias specifier rewritten to a relative
 * path. Declarations are emitted for whatever the three type entries reach.
 */
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import ts from 'typescript'
import { safeParseJson } from '../../src/core/utils/jsonValidate'
import { PLUGIN_API_VERSION } from '../../src/core/plugin-sdk/types/apiVersion'
import { SDK_PACKAGE_NAME, sdkTarballName } from '../../src/core/plugin-sdk/cli/sdkPackage'

const ROOT = resolve(import.meta.dir, '../..')
const SRC_DIR = join(ROOT, 'src')

/** Default output root: `.tmp/plugin-sdk/` holds `package/` and the tarball. */
const DEFAULT_SDK_OUT_ROOT = join(ROOT, '.tmp', 'plugin-sdk')

const RUNTIME_ENTRY = 'src/core/plugin-sdk/index.ts'
const CLI_ENTRY = 'src/core/plugin-sdk/cli/index.ts'

/** Type entries, keyed by the package subpath that exposes them. */
const TYPE_ENTRIES = {
  '.': 'src/core/plugin-sdk/index.ts',
  './host-ui': 'src/admin/plugin-host-ui/index.ts',
  './host-hooks': 'src/admin/plugin-host-hooks/index.ts',
} as const

/**
 * Packages the CLI loads at runtime instead of carrying inline. Both build a
 * DOM for the CLI under Bun (jsdom for the lint pass's sanitizer, happy-dom
 * for `definePack` layout compilation) and are far too large to inline.
 */
const RUNTIME_DEPENDENCIES = ['jsdom', 'happy-dom'] as const

/**
 * Packages the declaration files import, installed so a plugin typechecks
 * without `skipLibCheck`. TypeBox types the manifest and content shapes;
 * zustand, mutative and zustand-mutative type the editor store that
 * `useEditorStore` returns. None of them is loaded at runtime.
 */
const TYPE_DEPENDENCIES = ['@sinclair/typebox', 'zustand', 'mutative', 'zustand-mutative'] as const

/**
 * Packages the declaration files import that are peers, not dependencies.
 * `react` is the `@types/react` peer. It is required, not optional: the main
 * entry references `host.d.ts`, whose host UI types are React components, so
 * every program that imports the SDK loads them, a server-only plugin
 * included. The build fails when a package outside this list and the
 * dependencies appears, so widening the surface is a decision, not an
 * accident.
 */
const PEER_TYPE_PACKAGES = new Set(['react'])

/**
 * Type files copied into the package because their own package is not on
 * npm. The icon set is vendored in this repo; `IconComponent` is part of a
 * module definition's and a dashboard widget's public type.
 */
const VENDORED_TYPE_FILES: Record<string, { from: string; to: string }> = {
  'pixel-art-icons/types': { from: 'vendor/pixel-art-icons/dist/types.d.ts', to: 'vendor/pixel-art-icons/types.d.ts' },
}

export interface BuiltSdkPackage {
  version: string
  packageDir: string
  tarballPath: string
}

const RootPackageJsonSchema = Type.Object({
  version: Type.String(),
  license: Type.String(),
  author: Type.String(),
  homepage: Type.String(),
  bugs: Type.Unknown(),
  engines: Type.Object({ bun: Type.String() }),
  dependencies: Type.Record(Type.String(), Type.String()),
  devDependencies: Type.Record(Type.String(), Type.String()),
})
type RootPackageJson = Static<typeof RootPackageJsonSchema>

async function readRootPackageJson(): Promise<RootPackageJson> {
  const parsed = safeParseJson(await readFile(join(ROOT, 'package.json'), 'utf-8'), RootPackageJsonSchema)
  if (!parsed.ok) throw new Error(`[sdk:pack] package.json: ${parsed.error.message}`)
  return parsed.value
}

function dependencyRange(root: RootPackageJson, name: string): string {
  const range = root.dependencies[name] ?? root.devDependencies[name]
  if (!range) throw new Error(`[sdk:pack] ${name} is not a dependency of the repo; cannot pin it for the SDK package`)
  return range
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

async function buildJavaScript(distDir: string, version: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, RUNTIME_ENTRY), join(ROOT, CLI_ENTRY)],
    root: join(ROOT, 'src/core/plugin-sdk'),
    outdir: distDir,
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: false,
    external: [...RUNTIME_DEPENDENCIES, 'node:*'],
    naming: {
      entry: '[dir]/[name].[ext]',
      chunk: 'chunks/[name]-[hash].[ext]',
      asset: 'assets/[name]-[hash].[ext]',
    },
    define: { __INSTATIC_SDK_VERSION__: JSON.stringify(version) },
  })
  if (!result.success) {
    throw new Error(`[sdk:pack] bundling failed:\n${result.logs.map((log) => log.message).join('\n')}`)
  }

  // The CLI pulls in the base modules, whose components import CSS modules.
  // The bundler writes that CSS out as files nothing in a Bun CLI reads.
  for (const output of result.outputs) {
    if (!output.path.endsWith('.js')) await rm(output.path, { force: true })
  }
  await rm(join(distDir, 'assets'), { recursive: true, force: true })

  const cliPath = join(distDir, 'cli', 'index.js')
  await writeFile(cliPath, `#!/usr/bin/env bun\n${await readFile(cliPath, 'utf-8')}`, 'utf-8')
  await chmod(cliPath, 0o755)
}

async function listFiles(dir: string, extension: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(extension)) out.push(join(entry.parentPath, entry.name))
  }
  return out.sort()
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier)
}

/** Every non-relative specifier the built JavaScript still imports. */
export async function collectJavaScriptImports(distDir: string): Promise<Map<string, string[]>> {
  const transpiler = new Bun.Transpiler({ loader: 'js' })
  const imports = new Map<string, string[]>()
  for (const file of await listFiles(distDir, '.js')) {
    // The CLI entry starts with a shebang the scanner does not parse.
    const source = (await readFile(file, 'utf-8')).replace(/^#!.*\n/, '')
    for (const found of transpiler.scanImports(source)) {
      if (found.path.startsWith('.')) continue
      const files = imports.get(found.path) ?? []
      files.push(relative(distDir, file))
      imports.set(found.path, files)
    }
  }
  return imports
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

interface SpecifierEdit {
  start: number
  end: number
  text: string
}

function isUnderSource(fileName: string): boolean {
  return resolve(fileName).startsWith(SRC_DIR + sep)
}

/** `src/core/page-tree/index.ts` → `<typesDir>/core/page-tree/index` (no extension). */
function declarationTargetOf(sourceFile: string, typesDir: string): string {
  return join(typesDir, relative(SRC_DIR, resolve(sourceFile))).replace(/\.(d\.ts|tsx?)$/, '')
}

function relativeSpecifier(fromFile: string, toPathWithoutExtension: string): string {
  const path = relative(dirname(fromFile), toPathWithoutExtension).split(sep).join('/')
  return path.startsWith('.') ? path : `./${path}`
}

interface ModuleSpecifier {
  literal: ts.StringLiteralLike
  /** `declare module '…' { … }`: the name of a module this file augments. */
  augmentation: boolean
}

/** String literals that name a module in a declaration file (never comments). */
function collectModuleSpecifiers(file: ts.SourceFile): ModuleSpecifier[] {
  const found: ModuleSpecifier[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) found.push({ literal: node.moduleSpecifier, augmentation: false })
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        found.push({ literal: argument.literal, augmentation: false })
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression
      if (ts.isStringLiteralLike(expression)) found.push({ literal: expression, augmentation: false })
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteralLike(node.name)) {
      found.push({ literal: node.name, augmentation: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Every module specifier the declaration files under `typesDir` import. */
export async function collectDeclarationImports(typesDir: string): Promise<Map<string, string[]>> {
  const imports = new Map<string, string[]>()
  for (const file of await listFiles(typesDir, '.d.ts')) {
    const declaration = ts.createSourceFile(file, await readFile(file, 'utf-8'), ts.ScriptTarget.Latest, true)
    for (const { literal, augmentation } of collectModuleSpecifiers(declaration)) {
      if (augmentation) continue
      const files = imports.get(literal.text) ?? []
      files.push(relative(typesDir, file))
      imports.set(literal.text, files)
    }
  }
  return imports
}

interface ModuleAugmenter {
  /** Source file holding the `declare module '…'` block. */
  file: string
  /** Source file of the module it augments. */
  target: string
}

const AUGMENTATION_PATTERN = /^\s*declare module ['"]([^'"]+)['"]/gm

/** Every `declare module '<a module in src/>'` in the app source. */
async function findModuleAugmenters(
  resolveInSource: (specifier: string, fromFile: string) => string | null,
): Promise<ModuleAugmenter[]> {
  const augmenters: ModuleAugmenter[] = []
  const sources = [...(await listFiles(SRC_DIR, '.ts')), ...(await listFiles(SRC_DIR, '.tsx'))]
  for (const file of sources) {
    if (file.includes(`${sep}__tests__${sep}`) || file.endsWith('.d.ts')) continue
    const text = await readFile(file, 'utf-8')
    for (const match of text.matchAll(AUGMENTATION_PATTERN)) {
      const target = resolveInSource(match[1], file)
      if (target) augmenters.push({ file, target })
    }
  }
  return augmenters
}

interface DeclarationBuild {
  /** Bare package names the emitted declarations import. */
  externalPackages: Set<string>
}

async function buildDeclarations(typesDir: string): Promise<DeclarationBuild> {
  const configPath = join(ROOT, 'tsconfig.app.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    rootDir: SRC_DIR,
    outDir: typesDir,
  }
  const resolveInSource = (specifier: string, fromFile: string): string | null => {
    const resolved = ts.resolveModuleName(specifier, fromFile, options, ts.sys).resolvedModule
    if (!resolved || resolved.isExternalLibraryImport || !isUnderSource(resolved.resolvedFileName)) return null
    return resolve(resolved.resolvedFileName)
  }

  // Some types are assembled by module augmentation: `EditorStore` is an
  // empty interface that every store slice extends with
  // `declare module '@site/store/types'`. Those slice files are not imported
  // by anything the entries reach, so they are added as roots until no new
  // augmenter of an included module turns up.
  const augmenters = await findModuleAugmenters(resolveInSource)
  const rootNames = new Set(Object.values(TYPE_ENTRIES).map((entry) => join(ROOT, entry)))
  let program = ts.createProgram({ rootNames: [...rootNames], options })
  for (;;) {
    const included = new Set(program.getSourceFiles().map((file) => resolve(file.fileName)))
    const before = rootNames.size
    for (const { file, target } of augmenters) {
      if (included.has(target)) rootNames.add(file)
    }
    if (rootNames.size === before) break
    program = ts.createProgram({ rootNames: [...rootNames], options, oldProgram: program })
  }

  /** Emitted file of an augmented module → the emitted files that augment it. */
  const augmentersByTarget = new Map<string, string[]>()
  for (const { file, target } of augmenters) {
    if (!rootNames.has(file)) continue
    const targetOut = `${declarationTargetOf(target, typesDir)}.d.ts`
    const list = augmentersByTarget.get(targetOut) ?? []
    list.push(declarationTargetOf(file, typesDir))
    augmentersByTarget.set(targetOut, list)
  }

  const writes: Promise<void>[] = []

  const emit = program.emit(
    undefined,
    (outFile, text, _bom, _onError, sourceFiles) => {
      const source = sourceFiles?.[0]
      if (!source) throw new Error(`[sdk:pack] ${outFile} was emitted without a source file`)
      const declaration = ts.createSourceFile(outFile, text, ts.ScriptTarget.Latest, true)
      const edits: SpecifierEdit[] = []
      for (const { literal, augmentation } of collectModuleSpecifiers(declaration)) {
        const specifier = literal.text
        if (specifier.startsWith('.')) continue
        const vendored = VENDORED_TYPE_FILES[specifier]
        if (vendored) {
          edits.push({
            start: literal.getStart(declaration) + 1,
            end: literal.getEnd() - 1,
            text: relativeSpecifier(outFile, join(typesDir, vendored.to).replace(/\.d\.ts$/, '')),
          })
          continue
        }
        const resolved = resolveInSource(specifier, source.fileName)
        if (resolved) {
          const target = declarationTargetOf(resolved, typesDir)
          edits.push({
            start: literal.getStart(declaration) + 1,
            end: literal.getEnd() - 1,
            text: relativeSpecifier(outFile, target),
          })
        } else if (augmentation) {
          // A `declare module` naming something outside src/ is left as written.
          continue
        }
      }
      let rewritten = text
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
      }
      // An augmentation only applies when its file is part of the consumer's
      // program, so the augmented module pulls its augmenters in.
      for (const augmenter of augmentersByTarget.get(resolve(outFile)) ?? []) {
        rewritten += `import '${relativeSpecifier(outFile, augmenter)}';\n`
      }
      writes.push(mkdir(dirname(outFile), { recursive: true }).then(() => writeFile(outFile, rewritten, 'utf-8')))
    },
    undefined,
    true,
  )
  await Promise.all(writes)

  if (emit.diagnostics.length > 0) {
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    }
    throw new Error(`[sdk:pack] declaration emit failed:\n${ts.formatDiagnostics(emit.diagnostics, host)}`)
  }

  for (const { from, to } of Object.values(VENDORED_TYPE_FILES)) {
    await mkdir(dirname(join(typesDir, to)), { recursive: true })
    await cp(join(ROOT, from), join(typesDir, to))
  }

  await pruneUnreachableDeclarations(typesDir)

  const externalPackages = new Set<string>()
  for (const specifier of (await collectDeclarationImports(typesDir)).keys()) {
    if (!specifier.startsWith('.')) externalPackages.add(packageNameOf(specifier))
  }
  return { externalPackages }
}

/**
 * `tsc` emits a declaration for every file in the program, including the
 * ones an entry only reaches for values (the CLI, the collab engine, whole
 * editor panels). Keep what the type entries can actually reach through the
 * emitted declarations and delete the rest.
 */
async function pruneUnreachableDeclarations(typesDir: string): Promise<void> {
  const reachable = new Set<string>()
  const queue = Object.values(TYPE_ENTRIES).map((entry) => join(typesDir, relative('src', entry).replace(/\.tsx?$/, '.d.ts')))
  while (queue.length > 0) {
    const file = queue.pop()
    if (!file || reachable.has(file)) continue
    reachable.add(file)
    const declaration = ts.createSourceFile(file, await readFile(file, 'utf-8'), ts.ScriptTarget.Latest, true)
    for (const { literal } of collectModuleSpecifiers(declaration)) {
      if (!literal.text.startsWith('.')) continue
      const base = resolve(dirname(file), literal.text)
      const target = [`${base}.d.ts`, join(base, 'index.d.ts')].find((candidate) => existsSync(candidate))
      if (!target) throw new Error(`[sdk:pack] ${relative(typesDir, file)} imports "${literal.text}", which was not emitted`)
      queue.push(target)
    }
  }
  for (const file of await listFiles(typesDir, '.d.ts')) {
    if (!reachable.has(file)) await rm(file)
  }
  await removeEmptyDirectories(typesDir)
}

async function removeEmptyDirectories(dir: string): Promise<boolean> {
  let empty = true
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && (await removeEmptyDirectories(path))) continue
    empty = false
  }
  if (empty) await rm(dir, { recursive: true })
  return empty
}

function declarationPathOf(entry: string): string {
  return `./types/${relative('src', entry).replace(/\.tsx?$/, '.d.ts')}`
}

/**
 * The host supplies `@instatic/host-ui` and `@instatic/host-hooks` at runtime
 * through the editor's import map, so there is nothing to install for them.
 * This file gives the two bare specifiers their types.
 */
const HOST_DECLARATIONS = `/**
 * Types for the two modules the Instatic editor supplies to plugin code at
 * runtime. The CLI leaves both as bare imports; nothing is installed for them.
 */
declare module '@instatic/host-ui' {
  export * from '${SDK_PACKAGE_NAME}/host-ui'
}

declare module '@instatic/host-hooks' {
  export * from '${SDK_PACKAGE_NAME}/host-hooks'
}
`

async function writeHostDeclarations(packageDir: string): Promise<void> {
  await writeFile(join(packageDir, 'host.d.ts'), HOST_DECLARATIONS, 'utf-8')
  // Reference it from the main entry, so a project that imports the SDK gets
  // the host modules without listing them under `compilerOptions.types`.
  const mainTypes = join(packageDir, declarationPathOf(TYPE_ENTRIES['.']))
  const reference = relativeSpecifier(mainTypes, join(packageDir, 'host.d.ts'))
  await writeFile(mainTypes, `/// <reference path="${reference}" />\n${await readFile(mainTypes, 'utf-8')}`, 'utf-8')
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

function packageManifest(root: RootPackageJson, version: string): Record<string, unknown> {
  const dependencies: Record<string, string> = {}
  for (const name of [...RUNTIME_DEPENDENCIES, ...TYPE_DEPENDENCIES].sort()) {
    dependencies[name] = dependencyRange(root, name)
  }
  return {
    name: SDK_PACKAGE_NAME,
    version,
    description: 'Build plugins for the Instatic CMS: typed builders and the instatic-plugin CLI.',
    license: root.license,
    author: root.author,
    homepage: root.homepage,
    repository: SDK_REPOSITORY,
    bugs: root.bugs,
    type: 'module',
    engines: { bun: root.engines.bun.split(' ')[0] },
    bin: { 'instatic-plugin': './dist/cli/index.js' },
    exports: {
      '.': { types: declarationPathOf(TYPE_ENTRIES['.']), default: './dist/index.js' },
      './host-ui': { types: declarationPathOf(TYPE_ENTRIES['./host-ui']) },
      './host-hooks': { types: declarationPathOf(TYPE_ENTRIES['./host-hooks']) },
      './host': { types: './host.d.ts' },
      './package.json': './package.json',
    },
    types: declarationPathOf(TYPE_ENTRIES['.']),
    dependencies,
    peerDependencies: { '@types/react': dependencyRange(root, '@types/react').replace(/^[\^~]/, '>=') },
    // The plugin `apiVersion` this SDK writes into `plugin.json`.
    instatic: { pluginApiVersion: PLUGIN_API_VERSION },
  }
}

function assertDependenciesAreDeclared(
  manifest: Record<string, unknown>,
  javascriptImports: Map<string, string[]>,
  typePackages: Set<string>,
): void {
  const declared = new Set(Object.keys(manifest.dependencies as Record<string, string>))
  const problems: string[] = []
  for (const [specifier, files] of javascriptImports) {
    if (isNodeBuiltin(specifier) || declared.has(packageNameOf(specifier))) continue
    problems.push(`JavaScript imports "${specifier}" (${files.join(', ')}) but it is not a dependency`)
  }
  for (const name of typePackages) {
    if (declared.has(name) || PEER_TYPE_PACKAGES.has(name)) continue
    problems.push(`declarations import "${name}", which is neither a dependency nor the @types/react peer`)
  }
  if (problems.length > 0) throw new Error(`[sdk:pack] undeclared imports:\n  ${problems.join('\n  ')}`)
}

async function packTarball(outRoot: string, version: string): Promise<string> {
  const tarballPath = join(outRoot, sdkTarballName(version))
  await rm(tarballPath, { force: true })
  // npm tarballs hold the package under a top-level `package/` folder.
  const tar = Bun.spawn(['tar', '-czf', tarballPath, '-C', outRoot, 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await tar.exited) !== 0) throw new Error('[sdk:pack] tar failed')
  return tarballPath
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Written with the repository's real casing. npm checks a provenance
 * attestation's source repository against this field.
 */
const SDK_REPOSITORY = {
  type: 'git',
  url: 'git+https://github.com/CoreBunch/Instatic.git',
  directory: 'src/core/plugin-sdk',
}

export interface BuildSdkPackageOptions {
  /** Where `package/` and the tarball are written. */
  outRoot?: string
  /** Package version. Defaults to the repo's `package.json` version; a release passes its tag. */
  version?: string
}

export async function buildPluginSdkPackage(options: BuildSdkPackageOptions = {}): Promise<BuiltSdkPackage> {
  const outRoot = options.outRoot ?? DEFAULT_SDK_OUT_ROOT
  const root = await readRootPackageJson()
  const version = options.version ?? root.version
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`[sdk:pack] "${version}" is not a semver version (expected e.g. 1.2.3 or 1.2.3-rc.1)`)
  }
  const packageDir = join(outRoot, 'package')
  await rm(packageDir, { recursive: true, force: true })
  await mkdir(packageDir, { recursive: true })

  await buildJavaScript(join(packageDir, 'dist'), version)
  const declarations = await buildDeclarations(join(packageDir, 'types'))
  await writeHostDeclarations(packageDir)

  const manifest = packageManifest(root, version)
  assertDependenciesAreDeclared(
    manifest,
    await collectJavaScriptImports(join(packageDir, 'dist')),
    declarations.externalPackages,
  )
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  await cp(join(ROOT, 'src/core/plugin-sdk/README.md'), join(packageDir, 'README.md'))
  await cp(join(ROOT, 'LICENSE'), join(packageDir, 'LICENSE'))

  const tarballPath = await packTarball(outRoot, version)
  return { version, packageDir, tarballPath }
}
