import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { BunPlugin } from 'bun'

/**
 * Bundler plugins for the compiled server binary (`scripts/build-server-artifact.ts`).
 *
 * A `bun build --compile` binary is one bundled file under `/$bunfs/root`, and
 * two things stop being true for code inside it: `__dirname` is rewritten to a
 * string literal naming the source directory on the *build machine*, and
 * `createRequire(import.meta.url)` resolves against `/$bunfs`, where there is
 * no `node_modules`. A dependency that reads one of its own files at runtime
 * through either route works in dev and dies on boot everywhere the artifact
 * actually runs. v0.0.19, the first release to ship artifacts, could not start
 * on any machine for this reason. The compile step is what changes those
 * semantics, so it is also where they are repaired: at bundle time each such
 * read is replaced with the file's contents, redirected to a build of the
 * package that has none, or, for a worker the server never uses, removed.
 *
 * Every rewrite throws when its anchor is missing, so a dependency upgrade that
 * moves or removes a read fails the release build rather than the next boot.
 * `serverArtifactPlugins.test.ts` compiles the production sanitizer with these
 * plugins, checks the binary for the build machine's `node_modules` path, and
 * boots it with `node_modules` reads denied.
 */
export function serverArtifactPlugins(root: string): BunPlugin[] {
  return [
    forceSharpCjs(root),
    forceCssTreeCjs(root),
    inlineJsdomDefaultStylesheet(),
    disableJsdomSyncXhrWorker(),
    relocateEsbuildEntry(),
  ]
}

/**
 * `sharp`'s ESM entry loads its native binding via `createRequire(import.meta.url)`,
 * which cannot resolve bare specifiers inside a compiled binary. The CJS entry
 * uses literal `require()` calls the bundler embeds.
 */
function forceSharpCjs(root: string): BunPlugin {
  const sharpCjs = join(root, 'node_modules', 'sharp', 'dist', 'index.cjs')
  return {
    name: 'force-sharp-cjs',
    setup(build) {
      build.onResolve({ filter: /^sharp$/ }, () => ({ path: sharpCjs }))
    },
  }
}

/**
 * `jsdom/lib/jsdom/living/css/helpers/computed-style.js` reads the UA stylesheet
 * with `fs.readFileSync(path.resolve(__dirname, "../../../browser/default-stylesheet.css"))`
 * at module load. Bundled, `__dirname` is the build machine's absolute path, so
 * the binary boots only where it was built. Inline the 12 KB file instead.
 */
function inlineJsdomDefaultStylesheet(): BunPlugin {
  const read = /fs\.readFileSync\(\s*path\.resolve\(__dirname,\s*"([^"]+)"\),\s*\{\s*encoding:\s*"utf-8"\s*\}\s*\)/
  return {
    name: 'inline-jsdom-default-stylesheet',
    setup(build) {
      build.onLoad({ filter: /[\\/]jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]css[\\/]helpers[\\/]computed-style\.js$/ }, (args) => {
        const source = readFileSync(args.path, 'utf-8')
        const match = read.exec(source)
        if (!match) {
          throw new Error(
            `${args.path} no longer reads its stylesheet through __dirname; update inlineJsdomDefaultStylesheet in scripts/lib/serverArtifactPlugins.ts`,
          )
        }
        const stylesheet = readFileSync(resolve(dirname(args.path), match[1]), 'utf-8')
        return { contents: source.replace(read, JSON.stringify(stylesheet)), loader: 'js' }
      })
    },
  }
}

/**
 * css-tree's ESM build (`lib/`, which `@asamuzakjp/dom-selector` imports) loads
 * its data files through `createRequire(import.meta.url)` in `data.js`,
 * `data-patch.js`, and `version.js`. The bundler cannot follow those, and at
 * runtime they resolve against `/$bunfs`, so the binary fails on every machine,
 * the build machine included. The CJS build (`cjs/`) uses literal `require()`
 * calls the bundler embeds, so every `css-tree` specifier is routed to the
 * `require` target of its export map, the same treatment `sharp` gets above.
 */
function forceCssTreeCjs(root: string): BunPlugin {
  const pkgDir = join(root, 'node_modules', 'css-tree')
  const exportsMap = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')) as { exports: Record<string, string | { require?: string }> }).exports
  return {
    name: 'force-css-tree-cjs',
    setup(build) {
      build.onResolve({ filter: /^css-tree(\/.*)?$/ }, (args) => {
        const subpath = args.path === 'css-tree' ? '.' : `.${args.path.slice('css-tree'.length)}`
        const entry = exportsMap[subpath]
        const target = typeof entry === 'string' ? entry : entry?.require
        if (!target) {
          throw new Error(
            `css-tree's export map has no require target for ${args.path}; update forceCssTreeCjs in scripts/lib/serverArtifactPlugins.ts`,
          )
        }
        return { path: join(pkgDir, target) }
      })
    },
  }
}

/**
 * `jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js` resolves the worker behind
 * synchronous XHR with `require.resolve("./xhr-sync-worker.js")` at module load.
 * Bundled, that is the worker's absolute path on the build machine, resolved
 * again at boot from `/$bunfs`, which throws everywhere else. The server never
 * issues synchronous XHR (DOMPurify only parses), so the path becomes null and
 * the worker constructor a clear error rather than a dependency on the build
 * machine's disk.
 */
function disableJsdomSyncXhrWorker(): BunPlugin {
  const resolveWorker = 'require.resolve("./xhr-sync-worker.js")'
  const newWorker = 'new Worker(syncWorkerFile)'
  return {
    name: 'disable-jsdom-sync-xhr-worker',
    setup(build) {
      build.onLoad({ filter: /[\\/]jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/ }, (args) => {
        const source = readFileSync(args.path, 'utf-8')
        if (!source.includes(resolveWorker) || !source.includes(newWorker)) {
          throw new Error(
            `${args.path} no longer resolves its sync-XHR worker as expected; update disableJsdomSyncXhrWorker in scripts/lib/serverArtifactPlugins.ts`,
          )
        }
        const contents = source
          .replace(resolveWorker, 'null')
          .replace(
            newWorker,
            '(() => { throw new Error("Synchronous XMLHttpRequest is not available inside the compiled Instatic server binary") })()',
          )
        return { contents, loader: 'js' }
      })
    },
  }
}

/**
 * `esbuild/lib/main.js` checks that it still lives at `esbuild/lib/main.js`
 * and, without `ESBUILD_BINARY_PATH`, looks for its Go binary relative to
 * `__dirname`. Bundled, both names are the build machine's absolute paths.
 * The artifact entry sets `ESBUILD_BINARY_PATH` to an extracted copy
 * (`serverArtifactRuntime.ts`), so those paths are never followed; rewriting
 * them to fixed `/$bunfs` locations keeps esbuild's own location check true
 * and leaves no build-machine path in the binary.
 */
function relocateEsbuildEntry(): BunPlugin {
  return {
    name: 'relocate-esbuild-entry',
    setup(build) {
      build.onLoad({ filter: /[\\/]esbuild[\\/]lib[\\/]main\.js$/ }, (args) => {
        const source = readFileSync(args.path, 'utf-8')
        if (!source.includes('process.env.ESBUILD_BINARY_PATH') || !/\b__dirname\b/.test(source) || !/\b__filename\b/.test(source)) {
          throw new Error(
            `${args.path} no longer locates its binary as expected; update relocateEsbuildEntry in scripts/lib/serverArtifactPlugins.ts`,
          )
        }
        const contents = source
          .replace(/\b__filename\b/g, () => '"/$bunfs/root/node_modules/esbuild/lib/main.js"')
          .replace(/\b__dirname\b/g, () => '"/$bunfs/root/node_modules/esbuild/lib"')
        return { contents, loader: 'js' }
      })
    },
  }
}
